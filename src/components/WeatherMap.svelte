<!-- src/components/WeatherMap.svelte -->
<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import "maplibre-gl/dist/maplibre-gl.css";
    import maplibregl from "maplibre-gl";

    export let minHeight: string = "500px";

    let mapContainer: HTMLDivElement;
    let map: maplibregl.Map;

    onMount(() => {
        if (!mapContainer) return;

        map = new maplibregl.Map({
            container: mapContainer,
            // 使用 OpenFreeMap 的深色样式
            style: "https://tiles.openfreemap.org/styles/positron",
            center: [110, 0], // 初始中心点
            zoom: 1.5, // 缩小一点以便看到整个地球
            maxZoom: 20,
            // 开启反锯齿，让球体边缘更平滑
            canvasContextAttributes: { antialias: true },
        });

        // 关键步骤：在样式加载完成后，将投影设置为 'globe'
        map.on("style.load", () => {
            map.setProjection({
                type: "globe", // 开启球体投影
            });
        });

        // 添加导航控件
        map.addControl(new maplibregl.NavigationControl());

        // 生成模拟天气数据（越靠近赤道越热）
        const generateWeatherData = (count = 10000) => {
            const features: any[] = [];
            for (let i = 0; i < count; i++) {
                const lng = Math.random() * 360 - 180;
                const lat = Math.random() * 180 - 90;
                // 模拟温度：赤道(0度)附近高，两极低。简单模拟 30度 - |lat|/3
                // 加上一些随机波动
                const baseTemp = 35 - Math.abs(lat) * 0.4;
                const temp = baseTemp + (Math.random() * 10 - 5);
                // 归一化 magnitude 0-1 用于 heatmap
                // 假设范围 -10 到 40
                const flow = Math.max(0, (temp + 10) / 50);

                features.push({
                    type: "Feature",
                    properties: { mag: flow, temp: Math.round(temp) },
                    geometry: { type: "Point", coordinates: [lng, lat] },
                });
            }
            return { type: "FeatureCollection", features };
        };

        map.on("load", () => {
            // 示例：添加一个连接中国和澳洲的“诈骗链路”线
            map.addSource("scam-route", {
                type: "geojson",
                data: {
                    type: "Feature",
                    geometry: {
                        type: "LineString",
                        coordinates: [
                            [116.4074, 39.9042], // 北京
                            [151.2093, -33.8688], // 悉尼
                        ],
                    },
                },
            });

            map.addLayer({
                id: "route",
                type: "line",
                source: "scam-route",
                layout: {
                    "line-join": "round",
                    "line-cap": "round",
                },
                paint: {
                    "line-color": "#00ff00", // 黑客绿
                    "line-width": 3,
                    "line-opacity": 0.8,
                },
            });

            // 2. Weather Heatmap (New)
            if (!map.getSource("weather-data")) {
                const weatherData = generateWeatherData(10000);
                map.addSource("weather-data", {
                    type: "geojson",
                    data: weatherData,
                });

                map.addLayer(
                    {
                        id: "weather-heat",
                        type: "heatmap",
                        source: "weather-data",
                        maxzoom: 9,
                        paint: {
                            // Increase the heatmap weight based on frequency and property magnitude
                            "heatmap-weight": [
                                "interpolate",
                                ["linear"],
                                ["get", "mag"],
                                0,
                                0,
                                1,
                                1,
                            ],
                            // Increase the heatmap color weight weight by zoom level
                            // heatmap-intensity is a multiplier on top of heatmap-weight
                            "heatmap-intensity": [
                                "interpolate",
                                ["linear"],
                                ["zoom"],
                                0,
                                3,
                                9,
                                5,
                            ],
                            // Color ramp for heatmap.  Domain is 0 (low) to 1 (high).
                            // Begin color ramp at 0-stop with a 0-transparancy color
                            // to create a blur-like effect.
                            "heatmap-color": [
                                "interpolate",
                                ["linear"],
                                ["heatmap-density"],
                                0,
                                "rgba(33,102,172,0)",
                                0.1,
                                "rgb(103,169,207)",
                                0.3,
                                "rgb(209,229,240)",
                                0.5,
                                "rgb(253,219,199)",
                                0.7,
                                "rgb(239,138,98)",
                                1,
                                "rgb(178,24,43)",
                            ],
                            // Adjust the heatmap radius by zoom level
                            "heatmap-radius": [
                                "interpolate",
                                ["linear"],
                                ["zoom"],
                                0,
                                15,
                                9,
                                30,
                            ],
                            // Transition from heatmap to circle layer by zoom level
                            "heatmap-opacity": [
                                "interpolate",
                                ["linear"],
                                ["zoom"],
                                7,
                                1,
                                9,
                                0,
                            ],
                        },
                    },
                    "route",
                ); // Put heatmap below the route line
            }
        });
    });

    onDestroy(() => {
        map?.remove();
    });
</script>

<div class="map-wrap" style="height: {minHeight};">
    <div id="map" bind:this={mapContainer}></div>
</div>

<style>
    .map-wrap {
        position: relative;
        width: 100%;
        /* If parent has no height, 100% is 0. We force it to at least minHeight */
        min-height: 500px;
        height: 100%;
        border-radius: 8px;
        overflow: hidden;
    }

    #map {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 100%;
        /* 为了让“太空感”更强，我们甚至可以加一点星空背景（可选） */
        /* 简单的 CSS 渐变模拟大气层 */
        background: radial-gradient(circle at center, #1a202c 0%, #000 100%);
    }
</style>
