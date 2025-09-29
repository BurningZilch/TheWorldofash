<script lang="ts">
    import maplibregl from "maplibre-gl";

    // 公开环境变量（Astro 会在构建时注入）
    const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "";

    let mapContainer: HTMLDivElement;
    let map: maplibregl.Map;

    // UI 状态
    let year = 2000;              // 默认年份（可调试）
    let maskMode: "land" | "none" = "land";
    let loading = false;
    let errorMsg: string | null = null;

    // 当前叠加图层 id
    const OVERLAY_ID = "anomaly-tile";
    const OVERLAY_SRC_ID = "anomaly-src";

    // 色带：发散（负为蓝，正为红，0 为中性）
    // 返回 [r,g,b,a] (0-255)
    function divergingPalette(v: number, min = -5, max = 5): [number, number, number, number] {
        if (Number.isNaN(v)) return [0, 0, 0, 0]; // 透明
        const t = Math.max(0, Math.min(1, (v - min) / (max - min)));
        // 简单的两端蓝红，中间浅色（可替换更讲究的色带）
        let r: number, g: number, b: number;
        if (t < 0.5) {
            const k = t / 0.5;      // 0..1 蓝->白
            r = Math.round(255 * k);
            g = Math.round(255 * k);
            b = 255;
        } else {
            const k = (t - 0.5) / 0.5; // 0..1 白->红
            r = 255;
            g = Math.round(255 * (1 - k));
            b = Math.round(255 * (1 - k));
        }
        return [r, g, b, 200]; // 半透明
    }

    // 防抖
    let debounceTimer: number | null = null;
    function debounce(fn: () => void, ms = 250) {
        if (debounceTimer) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(fn, ms);
    }

    // 将 /tile 返回的矩阵转换为 Canvas PNG，并返回 {bitmap, bounds}
    async function makeOverlayFromTile(tile: any) {
        const lat: number[] = tile.lat; // N 行
        const lon: number[] = tile.lon; // M 列
        const values: (number | null)[][] = tile.values;

        const ni = lat.length;
        const nj = lon.length;

        // 构造像素尺寸（每格 16×16px，可按 zoom 调整）
        const pxPerCell = 16;
        const width = Math.max(1, nj * pxPerCell);
        const height = Math.max(1, ni * pxPerCell);

        // Canvas 绘制
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d")!;
        const img = ctx.createImageData(width, height);
        const data = img.data;

        for (let i = 0; i < ni; i++) {
            for (let j = 0; j < nj; j++) {
                const v = values[i][j];
                // 一个格子填满 pxPerCell×pxPerCell
                const [r, g, b, a] = v == null ? [0, 0, 0, 0] : divergingPalette(v, -5, 5);
                for (let dy = 0; dy < pxPerCell; dy++) {
                    for (let dx = 0; dx < pxPerCell; dx++) {
                        const x = j * pxPerCell + dx;
                        const y = i * pxPerCell + dy;
                        const idx = (y * width + x) * 4;
                        data[idx + 0] = r;
                        data[idx + 1] = g;
                        data[idx + 2] = b;
                        data[idx + 3] = a;
                    }
                }
            }
        }

        ctx.putImageData(img, 0, 0);
        const bitmap = await createImageBitmap(canvas);

        // 叠加范围：用外接矩形（min/max of lon/lat，加上半格扩展）
        const cellH = Math.abs(lat[1] - lat[0] || 5);
        const cellW = Math.abs(lon[1] - lon[0] || 5);

        const minLat = Math.min(...lat) - cellH / 2;
        const maxLat = Math.max(...lat) + cellH / 2;
        const minLon = Math.min(...lon) - cellW / 2;
        const maxLon = Math.max(...lon) + cellW / 2;

        return { bitmap, bounds: [minLon, minLat, maxLon, maxLat] as [number, number, number, number] };
    }

    // 依据地图视野，四舍五入到 5° 网格（避免重复请求）
    function snapBBoxTo5deg(bbox: [number, number, number, number]) {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const f = (x: number, fn: (n: number) => number) => fn(x / 5) * 5;
        return [
            f(minLon, Math.floor),
            f(minLat, Math.floor),
            f(maxLon, Math.ceil),
            f(maxLat, Math.ceil),
        ] as [number, number, number, number];
    }

    async function refreshOverlay() {
        if (!map) return;
        loading = true; errorMsg = null;

        try {
            const b = map.getBounds();
            // MapLibre Bounds: { _sw: {lng, lat}, _ne: {lng, lat} }
            const bbox = snapBBoxTo5deg([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
            const url = new URL(`${API_BASE}/tile`);
            url.searchParams.set("bbox", bbox.join(","));
            url.searchParams.set("time_year", String(year));
            url.searchParams.set("mask", maskMode);

            const res = await fetch(url.toString(), { mode: "cors" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const tile = await res.json();

            const { bitmap, bounds } = await makeOverlayFromTile(tile);

            // 清理旧图层
            if (map.getSource(OVERLAY_SRC_ID)) {
                map.removeLayer(OVERLAY_ID);
                map.removeSource(OVERLAY_SRC_ID);
            }

            // 添加自定义 image source
            map.addSource(OVERLAY_SRC_ID, {
                type: "image",
                url: bitmap as any, // MapLibre 允许直接传 HTMLImageElement，但我们有 ImageBitmap：
            } as any);

            // HACK：MapLibre 的 image source 需要 URL；我们采用 data URL 更兼容
            // 所以我们改用 <canvas> toDataURL：
            // 为简洁起见，上面用了 ImageBitmap。这里我们重做一遍为 dataURL：
            {
                const canvasTmp = document.createElement("canvas");
                canvasTmp.width = bitmap.width;
                canvasTmp.height = bitmap.height;
                const ctx2 = canvasTmp.getContext("2d")!;
                ctx2.drawImage(bitmap, 0, 0);
                const dataURL = canvasTmp.toDataURL("image/png");

                // 重新设置 Source，带上坐标
                if (map.getSource(OVERLAY_SRC_ID)) map.removeSource(OVERLAY_SRC_ID);
                map.addSource(OVERLAY_SRC_ID, {
                    type: "image",
                    url: dataURL,
                    coordinates: [
                        [bounds[0], bounds[3]], // 左上 (lon, lat)
                        [bounds[2], bounds[3]], // 右上
                        [bounds[2], bounds[1]], // 右下
                        [bounds[0], bounds[1]], // 左下
                    ],
                } as any);

                map.addLayer({
                    id: OVERLAY_ID,
                    type: "raster",
                    source: OVERLAY_SRC_ID,
                    paint: { "raster-opacity": 1.0 },
                });
            }
        } catch (e: any) {
            errorMsg = e?.message ?? String(e);
            console.error(e);
        } finally {
            loading = false;
        }
    }

    function initMap() {
        map = new maplibregl.Map({
            container: mapContainer,
            style: "https://demotiles.maplibre.org/style.json",
            center: [135, -25],
            zoom: 3,
            minZoom: 2,
            maxZoom: 10,
            attributionControl: true,
        });

        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

        map.on("load", () => refreshOverlay());
        map.on("moveend", () => debounce(refreshOverlay, 250));
        map.on("zoomend", () => debounce(refreshOverlay, 250));
    }

    // 初始化
    $: if (mapContainer) {
        if (!map) initMap();
    }

    function onYearInput(e: Event) {
        year = Number((e.target as HTMLInputElement).value);
        debounce(refreshOverlay, 150);
    }
</script>

<style>
    .wrap { display:grid; grid-template-rows: auto 1fr; height: 100%; }
    .toolbar {
        display:flex; gap:12px; align-items:center;
        padding:8px 12px; background:#fff; border-bottom:1px solid #eee;
    }
    .map { position: relative; }
    .map-canvas { position:absolute; inset:0; }
    .legend {
        position:absolute; bottom:10px; left:10px; padding:8px 10px;
        background:rgba(255,255,255,0.9); border-radius:8px; font-size:12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
    }
    .legend-bar {
        width: 240px; height: 10px; background: linear-gradient(90deg, #2b6cff, #ffffff, #ff4d4d);
        border-radius: 4px; margin: 6px 0;
    }
</style>

<div class="wrap">
    <div class="toolbar">
        <label>年份：
            <input type="range" min="1750" max="2024" step="1" bind:value={year} on:input={onYearInput} />
            <strong style="margin-left:6px">{year}</strong>
        </label>

        <label style="margin-left:16px">
            掩膜：
            <select bind:value={maskMode} on:change={() => debounce(refreshOverlay, 150)}>
                <option value="land">陆地</option>
                <option value="none">不掩膜</option>
            </select>
        </label>

        {#if loading}<span style="margin-left:12px;color:#888">加载中…</span>{/if}
        {#if errorMsg}<span style="margin-left:12px;color:#c00">错误：{errorMsg}</span>{/if}
    </div>

    <div class="map">
        <div bind:this={mapContainer} class="map-canvas"></div>
        <div class="legend">
            <div>温度距平（°C）</div>
            <div class="legend-bar"></div>
            <div style="display:flex; justify-content:space-between;">
                <span>-5</span><span>0</span><span>+5</span>
            </div>
        </div>
    </div>
</div>
