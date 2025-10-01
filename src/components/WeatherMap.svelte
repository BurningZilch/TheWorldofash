<!-- MapOverlay.svelte：可直接复制使用（Svelte + TypeScript） -->
<script lang="ts">
    import maplibregl from "maplibre-gl";
    import "maplibre-gl/dist/maplibre-gl.css";

    // 公开环境变量（Astro 在构建时注入）
    const API_BASE = import.meta.env.PUBLIC_API_BASE ?? "";

    let mapContainer: HTMLDivElement;
    let map: maplibregl.Map;

    // UI 状态
    let year = 2000;                        // 默认年份
    let maskMode: "land" | "none" = "land";
    let loading = false;
    let errorMsg: string | null = null;
    let errorDetail: string | null = null; // 详细错误信息

    // 当前叠加图层 id
    const OVERLAY_ID = "anomaly-tile";
    const OVERLAY_SRC_ID = "anomaly-src";

    /** 色带（发散，负为蓝，正为红）-> [r,g,b,a] (0-255) */
    function divergingPalette(v: number, min = -5, max = 5): [number, number, number, number] {
        if (Number.isNaN(v)) return [0, 0, 0, 0]; // 透明
        const t = Math.max(0, Math.min(1, (v - min) / (max - min)));
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

    // ---------- 错误增强 ----------
    function clip(s: string, n = 400) {
        return s.length > n ? s.slice(0, n) + " …" : s;
    }

    function hintFor(e: unknown, status?: number) {
        const msg = (e as any)?.message ?? String(e);
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
            return "可能是 CORS 或网络问题。检查 PUBLIC_API_BASE、HTTPS 以及服务器的 CORS 响应头。";
        }
        if (status === 404) return "接口不存在。确认后端是否提供了 /tile。";
        if (status === 401 || status === 403) return "鉴权或 CORS 被拦截。检查 Token 和 Access-Control-Allow-Origin。";
        if (status === 500) return "服务器内部错误。请查看后端/云函数日志。";
        if (msg.includes("Unexpected token") || msg.includes("JSON")) {
            return "返回内容不是合法 JSON。查看下方 Body 片段。";
        }
        return undefined;
    }

    /** 构造更友好的错误信息 */
    function buildError(
        e: unknown,
        ctx: { url?: string; status?: number; statusText?: string; body?: string } = {}
    ) {
        const statusPart = ctx.status ? `HTTP ${ctx.status}${ctx.statusText ? " " + ctx.statusText : ""}` : "";
        const base = (e as any)?.message ?? String(e);
        const tip = hintFor(e, ctx.status);
        const detailParts = [
            statusPart && `Status: ${statusPart}`,
            ctx.url && `URL: ${ctx.url}`,
            ctx.body && `Body: ${clip(ctx.body)}`,
            base && `Raw error: ${base}`,
        ].filter(Boolean);

        return {
            msg: [statusPart || "请求失败", tip ? `— ${tip}` : "", ctx.url ? `（URL: ${ctx.url}）` : ""]
                .filter(Boolean)
                .join(" "),
            detail: detailParts.join("\n"),
        };
    }
    // ---------- /错误增强 ----------

    // 防抖
    let debounceTimer: number | null = null;
    function debounce(fn: () => void, ms = 250) {
        if (debounceTimer) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(fn, ms);
    }

    /** /tile 返回的矩阵 -> Canvas PNG（dataURL）并给出地理 bounds */
    async function makeOverlayFromTile(tile: any) {
        const lat: number[] = tile.lat; // N 行
        const lon: number[] = tile.lon; // M 列
        const values: (number | null)[][] = tile.values;

        const ni = lat.length;
        const nj = lon.length;

        // 像素尺寸（每格 16×16px，可按 zoom 调整）
        const pxPerCell = 16;
        const width = Math.max(1, nj * pxPerCell);
        const height = Math.max(1, ni * pxPerCell);

        // Canvas（兼容 OffscreenCanvas 不可用的环境）
        let canvas: HTMLCanvasElement | OffscreenCanvas;
        let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;

        if (typeof (globalThis as any).OffscreenCanvas === "function") {
            canvas = new OffscreenCanvas(width, height);
            ctx = (canvas as OffscreenCanvas).getContext("2d");
        } else {
            const c = document.createElement("canvas");
            c.width = width;
            c.height = height;
            canvas = c;
            ctx = c.getContext("2d");
        }

        if (!ctx) throw new Error("Canvas 2D 上下文不可用");

        const img = ctx.createImageData(width, height);
        const data = img.data;

        for (let i = 0; i < ni; i++) {
            for (let j = 0; j < nj; j++) {
                const v = values[i][j];
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

        // 导出为 dataURL（MapLibre image source 更兼容）
        let dataURL: string;
        if (canvas instanceof OffscreenCanvas) {
            const bmp = await (canvas as OffscreenCanvas).convertToBlob({ type: "image/png" });
            dataURL = await blobToDataURL(bmp);
        } else {
            dataURL = (canvas as HTMLCanvasElement).toDataURL("image/png");
        }

        // 叠加范围：用外接矩形（min/max of lon/lat，加半格扩展）
        const cellH = Math.abs(lat[1] - lat[0] || 5);
        const cellW = Math.abs(lon[1] - lon[0] || 5);
        const minLat = Math.min(...lat) - cellH / 2;
        const maxLat = Math.max(...lat) + cellH / 2;
        const minLon = Math.min(...lon) - cellW / 2;
        const maxLon = Math.max(...lon) + cellW / 2;

        return {
            dataURL,
            bounds: [minLon, minLat, maxLon, maxLat] as [number, number, number, number],
        };
    }

    function blobToDataURL(blob: Blob): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /** 将地图视野四舍五入到 5° 网格（减少重复请求） */
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

    /** 核心：请求 /tile 并渲染叠加层，含增强错误信息 */
    async function refreshOverlay() {
        if (!map) return;
        loading = true; errorMsg = null; errorDetail = null;

        try {
            const b = map.getBounds();
            const bbox = snapBBoxTo5deg([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
            const url = new URL(`${API_BASE}/tile`);
            url.searchParams.set("bbox", bbox.join(","));
            url.searchParams.set("time_year", String(year));
            url.searchParams.set("mask", maskMode);

            const reqUrl = url.toString();
            const res = await fetch(reqUrl, { mode: "cors" });

            if (!res.ok) {
                const bodyText = await res.text().catch(() => "");
                const { msg, detail } = buildError(new Error(`HTTP ${res.status}`), {
                    url: reqUrl, status: res.status, statusText: res.statusText, body: bodyText
                });
                errorMsg = msg; errorDetail = detail;
                throw new Error(msg);
            }

            const ct = res.headers.get("content-type") || "";
            let tile: any;
            try {
                tile = await res.json();
            } catch (jsonErr) {
                const bodyText = await res.text().catch(() => "");
                const { msg, detail } = buildError(new Error("JSON parse error"), {
                    url: reqUrl, status: res.status, statusText: res.statusText, body: bodyText
                });
                errorMsg = msg;
                errorDetail = (ct ? `Content-Type: ${ct}\n` : "") + detail;
                throw jsonErr;
            }

            const { dataURL, bounds } = await makeOverlayFromTile(tile);

            // 清理旧图层
            if (map.getSource(OVERLAY_SRC_ID)) {
                if (map.getLayer(OVERLAY_ID)) map.removeLayer(OVERLAY_ID);
                map.removeSource(OVERLAY_SRC_ID);
            }

            // 添加 image source + 图层
            map.addSource(OVERLAY_SRC_ID, {
                type: "image",
                url: dataURL,
                coordinates: [
                    [bounds[0], bounds[3]], // 左上
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
        } catch (e: any) {
            if (!errorMsg) {
                const built = buildError(e);
                errorMsg = built.msg;
                errorDetail = built.detail;
            }
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

        // 捕获 MapLibre 内部错误
        map.on("error", (ev: any) => {
            const mlErr = ev?.error || ev;
            const { msg, detail } = buildError(mlErr, { url: "MapLibre style/source" });
            errorMsg = `Map error: ${msg}`;
            errorDetail = detail;
        });
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
        position: sticky; top: 0; z-index: 10;
    }
    .map { position: relative; min-height: 420px; }
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
    .error-tip {
        color:#c00; margin-left:12px;
    }
    details summary {
        cursor: pointer; user-select: none;
    }
    details pre {
        max-width: 720px; white-space: pre-wrap;
        font-size:12px; background:#f8f8f8; padding:8px;
        border-radius:6px; border:1px solid #eee;
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

        {#if errorMsg}
            <span class="error-tip">错误：{errorMsg}</span>
            {#if errorDetail}
                <details style="margin-left:12px">
                    <summary>详细信息</summary>
                    <pre>{errorDetail}</pre>
                </details>
            {/if}
        {/if}
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
