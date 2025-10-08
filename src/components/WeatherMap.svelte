<!-- src/components/WeatherMap.svelte
     高性能版 + 调试面板 + bbox 夹紧 + year→time_index 映射（/info）
     - Canvas Source + AbortController + 缓存 + 动态像素密度 + LUT
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
    let autoRefreshEnabled = true;
    let autoRefreshNotice: string | null = null;

    const OVERLAY_ID = "anomaly-tile";
    const OVERLAY_SRC_ID = "anomaly-src";

    // Canvas Source 的画布（隐藏于 DOM）
    let overlayCanvasEl: HTMLCanvasElement;
    let overlayCtx: CanvasRenderingContext2D | null = null;

    // 网络请求取消器
    let inFlight: AbortController | null = null;

    // /info 时间轴（小数年份），用于 year→time_index
    let timeAxis: number[] | null = null;

    // 缓存：key = "minLon,minLat,maxLon,maxLat@index@mask"
    type Bounds = [number, number, number, number];
    type CacheEntry = { image: ImageData; width: number; height: number; bounds: Bounds; pxPerCell: number };
    const tileCache = new Map<string, CacheEntry>();
    let currentKey: string | null = null;

    type ViewDescriptor = {
        bbox: Bounds;
        key: string;
        pxPerCell: number;
        timeIndex: number;
    };

    // ------- 调试：记录最近一次 API 请求与响应 -------
    type LastApi = {
        method: string;
        url: string;
        time: string;         // 本地时间
        durationMs: number;   // 耗时
        status: number;
        statusText: string;
        headers: string;      // 整理后响应头
        bodyPreview: string;  // 前 400 字符
        aborted?: boolean;
        note?: string;        // 附注（例如使用的 time_index）
        timeIndexUsed?: number;
        timeValueFromResp?: number | null;
    };
    let lastApi: LastApi | null = null;
    let debugOpen = false;

    function headersToPrettyString(h: Headers): string {
        const arr: string[] = [];
        h.forEach((v, k) => arr.push(`${k}: ${v}`));
        return arr.sort().join("\n");
    }

    // ------- 性能：LUT 上色 -------
    const LUT = new Uint8ClampedArray(256 * 4);
    (function buildLUT() {
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
    function cancelDebounce() {
        if (debounceTimer) {
            window.clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }
    function debounce(fn: () => void, ms = 200) {
        cancelDebounce();
        debounceTimer = window.setTimeout(() => {
            debounceTimer = null;
            fn();
        }, ms);
    }

    function disableAutoRefresh(reason = "拖动地图后需手动刷新。") {
        if (!autoRefreshEnabled) return;
        autoRefreshEnabled = false;
        autoRefreshNotice = reason;
        cancelDebounce();
    }

    function requestAutoRefresh(delay = 120) {
        if (!autoRefreshEnabled) return;
        debounce(() => refreshOverlay(), delay);
    }

    function manualRefresh() {
        loading = true;
        refreshOverlay();
    }

    // 5° 对齐
    function snapBBoxTo5deg(bbox: Bounds): Bounds {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        const f = (x: number, fn: (n: number) => number) => fn(x / 5) * 5;
        return [f(minLon, Math.floor), f(minLat, Math.floor), f(maxLon, Math.ceil), f(maxLat, Math.ceil)];
    }

    // 夹紧到世界范围
    function clampBBoxToWorld(b: Bounds): Bounds {
        let [minLon, minLat, maxLon, maxLat] = b;
        minLon = Math.max(-180, Math.min(180, minLon));
        maxLon = Math.max(-180, Math.min(180, maxLon));
        minLat = Math.max(-90, Math.min(90, minLat));
        maxLat = Math.max(-90, Math.min(90, maxLat));
        if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
        if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
        return [minLon, minLat, maxLon, maxLat];
    }

    // 缩放 → 每格像素
    function pxPerCellForZoom(z: number) {
        const v = Math.round(Math.pow(2, z - 3)); // z=3 -> 1, z=5 -> 4, z=7 -> 16
        return Math.max(2, Math.min(32, v));
    }

    // /info：获取时间轴（只拉一次）
    async function loadInfoOnce() {
        if (!API_BASE || timeAxis) return;
        try {
            const r = await fetch(`${API_BASE}/info`, { mode: "cors" });
            if (!r.ok) return;
            const j = await r.json();
            const arr = j?.arrays?.time as number[] | undefined;
            if (Array.isArray(arr) && arr.length > 0) timeAxis = arr;
        } catch {}
    }

    function pickTimeIndexFromYear(y: number): number {
        if (!timeAxis || timeAxis.length === 0) return 0;
        let best = 0, bestDiff = Infinity;
        for (let i = 0; i < timeAxis.length; i++) {
            const d = Math.abs(timeAxis[i] - y);
            if (d < bestDiff) { best = i; bestDiff = d; }
        }
        return best;
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

        // 如有需要翻转坐标方向
        const latFlipped = ni > 1 && lat[0] < lat[ni - 1];
        const lonFlipped = nj > 1 && lon[0] > lon[nj - 1];

        for (let i = 0; i < ni; i++) {
            const rowIdx = latFlipped ? ni - 1 - i : i;
            const y0 = rowIdx * pxPerCell;
            for (let j = 0; j < nj; j++) {
                const colIdx = lonFlipped ? nj - 1 - j : j;
                const x0 = colIdx * pxPerCell;

                const v = values[i][j];
                const transparent = v == null || Number.isNaN(v);
                const lutIdx = transparent ? 0 : valToLUTIndex(v as number, -5, 5);
                const r = transparent ? 0 : LUT[lutIdx * 4 + 0];
                const g = transparent ? 0 : LUT[lutIdx * 4 + 1];
                const b = transparent ? 0 : LUT[lutIdx * 4 + 2];
                const a = transparent ? 0 : LUT[lutIdx * 4 + 3];

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

    function cacheKey(bounds: Bounds, timeIndex: number, mask: string) {
        return `${bounds.join(",")}@${timeIndex}@${mask}`;
    }

    // 把 ImageData 绘到 overlayCanvasEl
    function paintToOverlayCanvas(entry: CacheEntry) {
        if (!overlayCtx) return;
        if (overlayCanvasEl.width !== entry.width || overlayCanvasEl.height !== entry.height) {
            overlayCanvasEl.width = entry.width;
            overlayCanvasEl.height = entry.height;
        }
        overlayCtx.putImageData(entry.image, 0, 0);
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
                animate: true,
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
            (src as any).setCoordinates(coords);
        }
    }

    // 核心刷新流程
    function describeCurrentView(): ViewDescriptor | null {
        if (!map) return null;
        const b = map.getBounds();
        const snapped = snapBBoxTo5deg([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
        const bbox = clampBBoxToWorld(snapped);
        const pxPerCell = pxPerCellForZoom(map.getZoom() ?? 3);
        const timeIndex = pickTimeIndexFromYear(year);
        return { bbox, key: cacheKey(bbox, timeIndex, maskMode), pxPerCell, timeIndex };
    }

    function useCachedOverlayIfPossible(view?: ViewDescriptor): boolean {
        if (!overlayCtx) return false;
        const descriptor = view ?? describeCurrentView();
        if (!descriptor) return false;
        const cached = tileCache.get(descriptor.key);
        if (!cached) return false;
        paintToOverlayCanvas(cached);
        ensureCanvasSource(cached);
        currentKey = descriptor.key;
        loading = false;
        return true;
    }

    async function refreshOverlay(options: { force?: boolean } = {}) {
        if (!map || !overlayCtx) return;

        const view = describeCurrentView();
        if (!view) return;

        const { bbox, key, pxPerCell, timeIndex } = view;

        loading = true; errorMsg = null; errorDetail = null;

        if (!options.force && useCachedOverlayIfPossible(view)) {
            return;
        }

        // 取消旧请求
        inFlight?.abort();
        const ac = new AbortController(); inFlight = ac;

        // 组装请求
        const url = new URL(`${API_BASE}/tile`);
        url.searchParams.set("bbox", bbox.join(","));
        url.searchParams.set("time_index", String(timeIndex));  // ✅ 使用 time_index
        url.searchParams.set("mask", maskMode);
        const reqUrl = url.toString();

        const started = performance.now();
        try {
            const res = await fetch(reqUrl, { mode: "cors", signal: ac.signal });
            if (ac.signal.aborted) {
                lastApi = {
                    method: "GET",
                    url: reqUrl,
                    time: new Date().toLocaleString(),
                    durationMs: Math.round(performance.now() - started),
                    status: 0,
                    statusText: "aborted",
                    headers: "",
                    bodyPreview: "",
                    aborted: true,
                    note: "请求在新一轮刷新到来之前被取消（AbortController）",
                    timeIndexUsed: timeIndex,
                };
                return;
            }

            const previewText = await res.clone().text().catch(() => "");
            const hdrs = headersToPrettyString(res.headers);

            if (!res.ok) {
                lastApi = {
                    method: "GET",
                    url: reqUrl,
                    time: new Date().toLocaleString(),
                    durationMs: Math.round(performance.now() - started),
                    status: res.status,
                    statusText: res.statusText,
                    headers: hdrs,
                    bodyPreview: clip(previewText),
                    timeIndexUsed: timeIndex,
                };
                const { msg, detail } = buildError(new Error(`HTTP ${res.status}`), {
                    url: reqUrl, status: res.status, statusText: res.statusText, body: previewText
                });
                errorMsg = msg; errorDetail = detail;
                throw new Error(msg);
            }

            // 解析 JSON
            let tile: any;
            try {
                tile = await res.json();
            } catch (jsonErr) {
                lastApi = {
                    method: "GET",
                    url: reqUrl,
                    time: new Date().toLocaleString(),
                    durationMs: Math.round(performance.now() - started),
                    status: res.status,
                    statusText: res.statusText + " (JSON parse error)",
                    headers: hdrs,
                    bodyPreview: clip(previewText),
                    timeIndexUsed: timeIndex,
                };
                const { msg, detail } = buildError(new Error("JSON parse error"), {
                    url: reqUrl, status: res.status, statusText: res.statusText, body: previewText
                });
                errorMsg = msg; errorDetail = detail;
                throw jsonErr;
            }

            // 成功：记录调试信息（含 time_value）
            lastApi = {
                method: "GET",
                url: reqUrl,
                time: new Date().toLocaleString(),
                durationMs: Math.round(performance.now() - started),
                status: 200,
                statusText: "OK",
                headers: hdrs,
                bodyPreview: clip(JSON.stringify(tile).slice(0, 400)),
                note: "请求参数已使用 time_index（由滑块年份映射）",
                timeIndexUsed: timeIndex,
                timeValueFromResp: typeof tile?.time_value === "number" ? tile.time_value : null,
            };

            // 生成像素
            const { image, width, height, bounds } = imageDataFromTile(tile, pxPerCell);
            const entry: CacheEntry = { image, width, height, bounds, pxPerCell };

            // 写缓存 & 绘制 & 确保 source
            tileCache.set(key, entry);
            paintToOverlayCanvas(entry);
            ensureCanvasSource(entry);
            currentKey = key;

            // 邻区预取（后台）
            prefetchNeighbors(bbox, timeIndex, maskMode, pxPerCell).catch(()=>{});
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
    async function prefetchNeighbors(bbox: Bounds, timeIndex: number, mask: string, pxPerCell: number) {
        const steps: Bounds[] = [
            [bbox[0] - 5, bbox[1], bbox[2] - 5, bbox[3]], // 左
            [bbox[0] + 5, bbox[1], bbox[2] + 5, bbox[3]], // 右
            [bbox[0], bbox[1] - 5, bbox[2], bbox[3] - 5], // 下
            [bbox[0], bbox[1] + 5, bbox[2], bbox[3] + 5], // 上
        ];
        for (const nb of steps) {
            const key = cacheKey(nb as Bounds, timeIndex, mask);
            if (tileCache.has(key)) continue;
            try {
                const url = new URL(`${API_BASE}/tile`);
                url.searchParams.set("bbox", (nb as Bounds).join(","));
                url.searchParams.set("time_index", String(timeIndex));
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

        // 先加载 /info（获取时间轴），完毕后刷新一次
        map.on("load", async () => {
            await loadInfoOnce().catch(()=>{});
            refreshOverlay();
        });
        map.on("moveend", () => {
            const hadCache = useCachedOverlayIfPossible();
            if (!hadCache) requestAutoRefresh(120);
        });
        map.on("zoomend", () => {
            const hadCache = useCachedOverlayIfPossible();
            if (!hadCache) requestAutoRefresh(120);
        });
        map.on("dragstart", () => disableAutoRefresh());

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
    .wrap { display:grid; grid-template-rows: auto auto 1fr; height: 100%; }
    .toolbar {
        display:flex; flex-wrap:wrap; gap:12px; align-items:center;
        padding:8px 12px;
        background: var(--surface);
        border-bottom:1px solid var(--border-color);
        color: var(--body-text);
        position: sticky; top: 0; z-index: 10;
        transition: background 0.3s ease, border-color 0.3s ease, color 0.3s ease;
    }
    .map { position: relative; }
    .map-canvas { position:absolute; inset:0; }
    .legend {
        position:absolute; bottom:10px; left:10px; padding:8px 10px;
        background: var(--surface-elevated);
        border-radius:8px; font-size:12px;
        border:1px solid var(--border-color);
        color: var(--body-text);
        box-shadow: var(--box-shadow);
        backdrop-filter: blur(12px);
    }
    .legend-bar {
        width: 240px; height: 10px; background: linear-gradient(90deg, #2b6cff, #ffffff, #ff4d4d);
        border-radius: 4px; margin: 6px 0;
    }
    .loading { margin-left:12px; color: var(--text-muted); }
    .mask-select { margin-left:16px; }
    .year-value { margin-left:6px; }
    .error-tip { color:#ff5d5d; margin-left:12px; font-weight:600; }
    .error-detail { margin-left:12px; }
    .manual-refresh-btn {
        margin-left:12px; padding:6px 12px;
        border-radius:6px; border:1px solid var(--border-color);
        background: var(--surface-elevated);
        color: var(--body-text); cursor:pointer;
        transition: background 0.2s ease, color 0.2s ease;
    }
    .manual-refresh-btn:disabled {
        opacity:0.6; cursor: not-allowed;
    }
    .auto-disabled-note {
        margin-left:12px; color: var(--text-muted); font-size:13px;
    }
    details summary { cursor: pointer; user-select: none; }
    details pre {
        max-width: 100%; white-space: pre-wrap;
        font-size:12px; background:var(--code-background); padding:8px;
        border-radius:6px; border:1px solid var(--border-color); overflow:auto;
        color: var(--body-text);
    }

    /* 调试面板 */
    .debug {
        padding:8px 12px;
        background: var(--surface-2, #fafafa);
        border-bottom:1px solid var(--border-color, #eee);
        color: var(--body-text);
        font-size: 13px;
    }
    .debug .kv { color:#666; }
    .debug code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
</style>

<div class="wrap">
    <div class="toolbar">
        <label>年份：
            <input type="range" min="1750" max="2024" step="1" bind:value={year} on:input={onYearInput} />
            <strong class="year-value">{year}</strong>
        </label>

        <label class="mask-select">
            掩膜：
            <select bind:value={maskMode} on:change={() => debounce(refreshOverlay, 120)}>
                <option value="land">陆地</option>
                <option value="none">不掩膜</option>
            </select>
        </label>

        {#if loading}<span class="loading">加载中…</span>{/if}

        <button class="manual-refresh-btn" type="button" on:click={manualRefresh} disabled={loading}>
            刷新数据
        </button>

        {#if !autoRefreshEnabled && autoRefreshNotice}
            <span class="auto-disabled-note">{autoRefreshNotice}</span>
        {/if}

        {#if errorMsg}
            <span class="error-tip">错误：{errorMsg}</span>
            {#if errorDetail}
                <details class="error-detail">
                    <summary>详细信息</summary>
                    <pre>{errorDetail}</pre>
                </details>
            {/if}
        {/if}
    </div>

    <!-- 🔎 调试面板：显示最近一次 API 调用 -->
    <div class="debug">
        <details bind:open={debugOpen}>
            <summary><strong>最近一次 API 调试信息</strong>（点击展开/收起）</summary>
            {#if lastApi}
                <div style="margin-top:8px; display:grid; gap:6px">
                    <div class="kv"><b>Method</b>：<code>{lastApi.method}</code></div>
                    <div class="kv"><b>URL</b>：<code>{lastApi.url}</code></div>
                    <div class="kv"><b>时间</b>：<code>{lastApi.time}</code></div>
                    <div class="kv"><b>耗时</b>：<code>{lastApi.durationMs} ms</code></div>
                    <div class="kv"><b>状态</b>：<code>{lastApi.status} {lastApi.statusText}</code></div>
                    {#if lastApi.timeIndexUsed !== undefined}
                        <div class="kv"><b>time_index</b>：<code>{lastApi.timeIndexUsed}</code></div>
                    {/if}
                    {#if lastApi.timeValueFromResp !== undefined}
                        <div class="kv"><b>time_value</b>：<code>{lastApi.timeValueFromResp ?? "(无)"}</code></div>
                    {/if}
                    {#if lastApi.aborted}
                        <div class="kv"><b>已取消</b>：<code>true</code></div>
                    {/if}
                    {#if lastApi.note}
                        <div class="kv"><b>备注</b>：<code>{lastApi.note}</code></div>
                    {/if}
                    <div>
                        <h4 style="margin:8px 0 6px">响应头</h4>
                        <pre>{lastApi.headers}</pre>
                    </div>
                    <div>
                        <h4 style="margin:8px 0 6px">响应体预览（前 400 字符）</h4>
                        <pre>{lastApi.bodyPreview}</pre>
                    </div>
                </div>
            {:else}
                <div style="margin-top:8px;color:#666">（暂无）移动地图或更改年份以触发请求。</div>
            {/if}
        </details>
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
