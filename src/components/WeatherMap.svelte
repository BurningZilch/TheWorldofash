<!-- src/components/WeatherMap.svelte
     高性能版：Canvas Source + AbortController + 缓存 + 动态像素密度 + LUT
-->
<script lang="ts">
    import { onMount } from "svelte";

    // Amplify 构建时注入（不要带末尾斜杠）
    const API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? "";

    let mapContainer: HTMLDivElement;
    let map: any;            // 动态导入后再赋值具体类型
    let maplibregl: any;

    export let minHeight: string = "420px";

    // UI 状态
    let year = 2000;
    let maskMode: "land" | "none" = "land";
    let loading = false;
    let errorMsg: string | null = null;
    let errorDetail: string | null = null;

    const OVERLAY_ID = "anomaly-tile";
    const OVERLAY_SRC_ID = "anomaly-src";

    // 用于 Canvas Source 的画布（隐藏于 DOM）
    let overlayCanvasEl: HTMLCanvasElement;
    let overlayCtx: CanvasRenderingContext2D | null = null;

    // 网络请求的取消器
    let inFlight: AbortController | null = null;

    // 缓存：key = "minLon,minLat,maxLon,maxLat@year@mask"
    type Bounds = [number, number, number, number];
    type CacheEntry = { image: ImageData; width: number; height: number; bounds: Bounds; pxPerCell: number };
    const tileCache = new Map<string, CacheEntry>();
    let currentKey: string | null = null;

    // ------- 性能：LUT 上色 -------
    // 把 [-5, +5] 映射到 0..255，并为每个强度预生成 RGBA
    const LUT = new Uint8ClampedArray(256 * 4);
    (function buildLUT() {
        // 用与之前 divergingPalette 等价的蓝-白-红发散色带
        for (let i = 0; i < 256; i++) {
            const t = i / 255; // 0..1
            let r: number, g: number, b: number;
            if (t < 0.5) {
                const k = t / 0.5;
                r = Math.round(255 * k);
                g = Math.round(255 * k);
                b = 255;
            } else {
                const k = (t - 0.5) / 0.5;
                r = 255;
                g = Math.round(255 * (1 - k));
                b = Math.round(255 * (1 - k));
            }
            const o = i * 4;
            LUT[o + 0] = r;
            LUT[o + 1] = g;
            LUT[o + 2] = b;
            LUT[o + 3] = 200; // 半透明
        }
    })();

    function valToLUTIndex(v: number, vmin = -5, vmax = 5): number {
        // NaN 在调用处处理
        const t = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin)));
        return (t * 255) | 0;
    }

    // ------- 小工具 -------
    function clip(s: string, n = 400) {
        return s.length > n ? s.slice(0, n) + " …" : s;
    }
    function hintFor(e: unknown, status?: number) {
        const msg = (e as any)?.message ?? String(e);
        if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return "可能是 CORS 或网络问题。检查 PUBLIC_API_BASE、HTTPS 以及服务器的 CORS 响应头。";
        if (status === 404) return "接口不存在。确认后端是否提供了 /tile。";
        if (status === 401 || status === 403) return "鉴权或 CORS 被拦截。检查 Token 和 Access-Control-Allow-Origin。";
        if (status === 500) return "服务器内部错误。请查看后端/云函数日志。";
        if (msg.includes("Unexpected token") || msg.includes("JSON")) return "返回内容不是合法 JSON。";
        return undefined;
    }
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
            msg: [statusPart || "请求失败", tip ? `— ${tip}` : "", ctx.url ? `（URL: ${ctx.url}）` : ""].filter(Boolean).join(" "),
            detail: detailParts.join("\n"),
        };
    }

    // 防抖
    let debounceTimer: number | null = null;
    function debounce(fn: () => void, ms = 200) {
        if (debounceTimer) window.clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(fn, ms);
    }

    // 5° 对齐（减少重复请求）
    function snapBBoxTo5deg(bbox: Bounds): Bounds {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const f = (x: number, fn: (n: number) => number) => fn(x / 5) * 5;
        return [f(minLon, Math.floor), f(minLat, Math.floor), f(maxLon, Math.ceil), f(maxLat, Math.ceil)];
    }

    // 缩放 → 每格像素
    function pxPerCellForZoom(z: number) {
        const v = Math.round(Math.pow(2, z - 3)); // z=3 -> 1, z=5 -> 4, z=7 -> 16
        return Math.max(2, Math.min(32, v));
    }

    // 生成像素（ImageData），同时返回 bounds
    function imageDataFromTile(tile: any, pxPerCell: number) {
        const lat: number[] = tile.lat;
        const lon: number[] = tile.lon;
        const values: (number | null)[][] = tile.values;

        const ni = lat.length, nj = lon.length;
        const width = Math.max(1, nj * pxPerCell);
        const height = Math.max(1, ni * pxPerCell);
        const image = new ImageData(width, height);
        const data = image.data;

        // 计算地理 bounds（半格扩展）
        const cellH = Math.abs(lat[1] - lat[0] || 5);
        const cellW = Math.abs(lon[1] - lon[0] || 5);
        const minLat = Math.min(...lat) - cellH / 2;
        const maxLat = Math.max(...lat) + cellH / 2;
        const minLon = Math.min(...lon) - cellW / 2;
        const maxLon = Math.max(...lon) + cellW / 2;
        const bounds: Bounds = [minLon, minLat, maxLon, maxLat];

        // 填像素（按格子扩展）
        for (let i = 0; i < ni; i++) {
            for (let j = 0; j < nj; j++) {
                const v = values[i][j];
                const transparent = v == null || Number.isNaN(v);
                const lutIdx = transparent ? 0 : valToLUTIndex(v as number, -5, 5);
                const r = transparent ? 0 : LUT[lutIdx * 4 + 0];
                const g = transparent ? 0 : LUT[lutIdx * 4 + 1];
                const b = transparent ? 0 : LUT[lutIdx * 4 + 2];
                const a = transparent ? 0 : LUT[lutIdx * 4 + 3];

                const x0 = j * pxPerCell;
                const y0 = i * pxPerCell;
                for (let dy = 0; dy < pxPerCell; dy++) {
                    let row = (y0 + dy) * width + x0;
                    let idx = row * 4;
                    for (let dx = 0; dx < pxPerCell; dx++) {
                        data[idx++] = r;
                        data[idx++] = g;
                        data[idx++] = b;
                        data[idx++] = a;
                    }
                }
            }
        }

        return { image, width, height, bounds };
    }

    function cacheKey(bounds: Bounds, year: number, mask: string) {
        return `${bounds.join(",")}@${year}@${mask}`;
    }

    // 把 ImageData 绘到 overlayCanvasEl
    function paintToOverlayCanvas(entry: CacheEntry) {
        if (!overlayCtx) return;
        if (overlayCanvasEl.width !== entry.width || overlayCanvasEl.height !== entry.height) {
            overlayCanvasEl.width = entry.width;
            overlayCanvasEl.height = entry.height;
        }
        overlayCtx.putImageData(entry.image, 0, 0);
        // 提醒 MapLibre 重绘
        map && (map as any).triggerRepaint?.();
    }

    // 安全设置/更新 canvas source 的坐标
    function ensureCanvasSource(entry: CacheEntry) {
        const src = map.getSource(OVERLAY_SRC_ID);
        const coords = [
            [entry.bounds[0], entry.bounds[3]],
            [entry.bounds[2], entry.bounds[3]],
            [entry.bounds[2], entry.bounds[1]],
            [entry.bounds[0], entry.bounds[1]],
        ];
        if (!src) {
            map.addSource(OVERLAY_SRC_ID, {
                type: "canvas",
                canvas: overlayCanvasEl,
                coordinates: coords,
                animate: true, // 每次绘完会触发 repaint
            } as any);
            if (!map.getLayer(OVERLAY_ID)) {
                map.addLayer({
                    id: OVERLAY_ID,
                    type: "raster",
                    source: OVERLAY_SRC_ID,
                    paint: { "raster-opacity": 1.0 },
                });
            }
        } else {
            // 更新坐标（避免频繁销毁/创建）
            (src as any).setCoordinates(coords);
        }
    }

    // 核心刷新流程
    async function refreshOverlay() {
        if (!map || !overlayCtx) return;

        loading = true; errorMsg = null; errorDetail = null;

        // 计算对齐 bbox
        const b = map.getBounds();
        const bbox = snapBBoxTo5deg([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);

        // 以当前缩放决定像素密度
        const pxPerCell = pxPerCellForZoom(map.getZoom() ?? 3);

        const key = cacheKey(bbox, year, maskMode);
        const cached = tileCache.get(key);
        if (cached && cached.pxPerCell === pxPerCell) {
            // 直接复用：画并更新 source 坐标
            paintToOverlayCanvas(cached);
            ensureCanvasSource(cached);
            currentKey = key;
            loading = false;
            return;
        }

        // 取消旧请求
        inFlight?.abort();
        const ac = new AbortController(); inFlight = ac;

        try {
            // 请求
            const url = new URL(`${API_BASE}/tile`);
            url.searchParams.set("bbox", bbox.join(","));
            url.searchParams.set("time_year", String(year));
            url.searchParams.set("mask", maskMode);
            const reqUrl = url.toString();

            const res = await fetch(reqUrl, { mode: "cors", signal: ac.signal });
            if (ac.signal.aborted) return;

            if (!res.ok) {
                const bodyText = await res.text().catch(() => "");
                const { msg, detail } = buildError(new Error(`HTTP ${res.status}`), {
                    url: reqUrl, status: res.status, statusText: res.statusText, body: bodyText
                });
                errorMsg = msg; errorDetail = detail;
                throw new Error(msg);
            }

            let tile: any;
            try {
                tile = await res.json();
            } catch (jsonErr) {
                const bodyText = await res.text().catch(() => "");
                const { msg, detail } = buildError(new Error("JSON parse error"), {
                    url: reqUrl, status: res.status, statusText: res.statusText, body: bodyText
                });
                errorMsg = msg; errorDetail = detail;
                throw jsonErr;
            }

            // 生成像素
            const { image, width, height, bounds } = imageDataFromTile(tile, pxPerCell);
            const entry: CacheEntry = { image, width, height, bounds, pxPerCell };

            // 写缓存 & 绘制 & 确保 source
            tileCache.set(key, entry);
            paintToOverlayCanvas(entry);
            ensureCanvasSource(entry);
            currentKey = key;

            // 轻量“邻区预取”（左右上下各一格），后台缓存，不画
            prefetchNeighbors(bbox, year, maskMode, pxPerCell).catch(()=>{ /* 忽略预取失败 */ });

        } catch (e: any) {
            if (!errorMsg) {
                const built = buildError(e);
                errorMsg = built.msg;
                errorDetail = built.detail;
            }
            console.error(e);
        } finally {
            if (inFlight === ac) inFlight = null;
            loading = false;
        }
    }

    // 预取相邻对齐 bbox（±5° 方向）
    async function prefetchNeighbors(bbox: Bounds, yr: number, mask: string, pxPerCell: number) {
        const steps: Bounds[] = [
            [bbox[0] - 5, bbox[1], bbox[2] - 5, bbox[3]], // 左
            [bbox[0] + 5, bbox[1], bbox[2] + 5, bbox[3]], // 右
            [bbox[0], bbox[1] - 5, bbox[2], bbox[3] - 5], // 下
            [bbox[0], bbox[1] + 5, bbox[2], bbox[3] + 5], // 上
        ];
        for (const nb of steps) {
            const key = cacheKey(nb, yr, mask);
            if (tileCache.has(key)) continue;
            try {
                const url = new URL(`${API_BASE}/tile`);
                url.searchParams.set("bbox", nb.join(","));
                url.searchParams.set("time_year", String(yr));
                url.searchParams.set("mask", mask);
                const res = await fetch(url.toString(), { mode: "cors" });
                if (!res.ok) continue;
                const tile = await res.json();
                const { image, width, height, bounds } = imageDataFromTile(tile, pxPerCell);
                tileCache.set(key, { image, width, height, bounds, pxPerCell });
            } catch {}
        }
    }

    // ------- 初始化 MapLibre -------
    function initMap() {
        if (!maplibregl || !mapContainer) return;

        // 初始化隐藏画布
        overlayCanvasEl = document.createElement("canvas");
        overlayCanvasEl.style.position = "absolute";
        overlayCanvasEl.style.left = "-99999px"; // 不占布局
        document.body.appendChild(overlayCanvasEl);
        overlayCtx = overlayCanvasEl.getContext("2d");
        if (overlayCtx) overlayCtx.imageSmoothingEnabled = false;

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
        map.on("moveend", () => debounce(refreshOverlay, 120));
        map.on("zoomend", () => debounce(refreshOverlay, 120));

        map.on("error", (ev: any) => {
            const mlErr = ev?.error || ev;
            const { msg, detail } = buildError(mlErr, { url: "MapLibre style/source" });
            errorMsg = `Map error: ${msg}`;
            errorDetail = detail;
        });
    }

    // 动态导入（避免 HMR/SSR 的模块未定义）
    onMount(async () => {
        try {
            const mod = await import("maplibre-gl");
            await import("maplibre-gl/dist/maplibre-gl.css");
            maplibregl = (mod as any).default ?? mod;
            if (mapContainer) initMap();
        } catch (e) {
            errorMsg = "地图库加载失败";
            errorDetail = String(e);
            console.error(e);
        }
    });

    // 容器出现且库已加载 → 初始化地图
    $: if (maplibregl && mapContainer && !map) {
        initMap();
    }

    function onYearInput(e: Event) {
        year = Number((e.target as HTMLInputElement).value);
        debounce(refreshOverlay, 150);
    }
</script>

<style>
    .wrap { display:grid; grid-template-rows: auto 1fr; height: 100%; }
    .toolbar {
        display:flex; flex-wrap:wrap; gap:12px; align-items:center;
        padding:8px 12px; background:#fff; border-bottom:1px solid #eee;
        position: sticky; top: 0; z-index: 10;
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
    .error-tip { color:#c00; margin-left:12px; }
    details summary { cursor: pointer; user-select: none; }
    details pre {
        max-width: 100%; white-space: pre-wrap;
        font-size:12px; background:#f8f8f8; padding:8px;
        border-radius:6px; border:1px solid #eee; overflow:auto;
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
            <select bind:value={maskMode} on:change={() => debounce(refreshOverlay, 120)}>
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

    <div class="map" style={`min-height: ${minHeight};`}>
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
