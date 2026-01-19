<!-- src/components/WeatherMap.svelte -->
<script lang="ts">
    import { onMount, onDestroy } from "svelte";
    import "maplibre-gl/dist/maplibre-gl.css";
    import maplibregl from "maplibre-gl";

    export let minHeight: string = "500px";

    let mapContainer: HTMLDivElement;
    let map: maplibregl.Map;

    let timeIndex = 3310; // Latest time by default
    let isPlaying = false;
    let playInterval: any;
    let currentTimeString = "Loading...";
    let viewMode: "land" | "global" = "land";

    async function loadWeatherData(index: number) {
        try {
            const response = await fetch(
                `/api/weather?timeIndex=${index}&viewMode=${viewMode}`,
            );
            const weatherData = await response.json();
            currentTimeString = weatherData.metadata.time;

            if (map && map.getSource("weather-data")) {
                (map.getSource("weather-data") as any).setData(weatherData);
            } else if (map) {
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
                            "heatmap-weight": [
                                "interpolate",
                                ["linear"],
                                ["get", "mag"],
                                0,
                                0,
                                1,
                                1,
                            ],
                            "heatmap-intensity": [
                                "interpolate",
                                ["linear"],
                                ["zoom"],
                                0,
                                3,
                                9,
                                5,
                            ],
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
                            "heatmap-radius": [
                                "interpolate",
                                ["linear"],
                                ["zoom"],
                                0,
                                10,
                                9,
                                20,
                            ],
                            "heatmap-opacity": [
                                "interpolate",
                                ["linear"],
                                ["zoom"],
                                7,
                                0.8,
                                9,
                                0,
                            ],
                        },
                    },
                    "route",
                );
            }
        } catch (error) {
            console.error("Failed to load weather data:", error);
        }
    }

    function togglePlay() {
        isPlaying = !isPlaying;
        if (isPlaying) {
            playInterval = setInterval(() => {
                timeIndex = (timeIndex + 1) % 3311;
                loadWeatherData(timeIndex);
            }, 500); // Update every 500ms
        } else {
            clearInterval(playInterval);
        }
    }

    function toggleViewMode(mode: "land" | "global") {
        if (viewMode === mode) return;
        viewMode = mode;
        loadWeatherData(timeIndex);
    }

    function handleSliderChange(e: any) {
        timeIndex = parseInt(e.target.value);
        loadWeatherData(timeIndex);
    }

    onMount(() => {
        if (!mapContainer) return;

        map = new maplibregl.Map({
            container: mapContainer,
            style: "https://tiles.openfreemap.org/styles/positron",
            center: [0, 0],
            zoom: 1.5,
            canvasContextAttributes: { antialias: true },
        });

        map.on("style.load", () => {
            map.setProjection({ type: "globe" });
        });

        map.addControl(new maplibregl.NavigationControl());

        map.on("load", () => {
            // Restore missing route layer for the weather layer to depend on
            if (!map.getSource("scam-route")) {
                map.addSource("scam-route", {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        properties: {},
                        geometry: {
                            type: "LineString",
                            coordinates: [
                                [116.4074, 39.9042], // Beijing
                                [151.2093, -33.8688], // Sydney
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
                        "line-color": "#00ff00",
                        "line-width": 3,
                        "line-opacity": 0.8,
                    },
                });
            }

            loadWeatherData(timeIndex);
        });
    });

    onDestroy(() => {
        map?.remove();
        if (playInterval) clearInterval(playInterval);
    });
</script>

<div class="map-wrap" style="height: {minHeight};">
    <div id="map" bind:this={mapContainer}></div>

    <!-- Timeline Overlay -->

    <div class="timeline-overlay">
        <div class="time-info">
            <span class="date">{currentTimeString}</span>
            <div class="controls">
                <button
                    class="view-toggle {viewMode === 'land' ? 'active' : ''}"
                    on:click={() => toggleViewMode("land")}
                >
                    Land
                </button>
                <button
                    class="view-toggle {viewMode === 'global' ? 'active' : ''}"
                    on:click={() => toggleViewMode("global")}
                >
                    Global
                </button>
                <button class="play-btn" on:click={togglePlay}>
                    {isPlaying ? "⏸ Pause" : "▶ Play"}
                </button>
            </div>
        </div>
        <input
            type="range"
            min="0"
            max="3310"
            value={timeIndex}
            on:input={handleSliderChange}
            class="slider"
        />
    </div>
</div>

<style>
    .map-wrap {
        position: relative;
        width: 100%;
        min-height: 500px;
        height: 100%;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }

    #map {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 100%;
        background: radial-gradient(circle at center, #1a202c 0%, #000 100%);
    }

    .timeline-overlay {
        position: absolute;
        bottom: 20px;
        left: 20px;
        right: 20px;
        background: rgba(15, 23, 42, 0.85);
        backdrop-filter: blur(8px);
        padding: 15px 20px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: white;
        z-index: 10;
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .time-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .controls {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .view-toggle {
        background: rgba(255, 255, 255, 0.1);
        color: #94a3b8;
        border: 1px solid rgba(255, 255, 255, 0.2);
        padding: 4px 10px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 0.9rem;
        transition: all 0.2s;
    }

    .view-toggle.active {
        background: #3b82f6;
        color: white;
        border-color: #3b82f6;
    }

    .view-toggle:hover:not(.active) {
        background: rgba(255, 255, 255, 0.2);
        color: white;
    }

    .date {
        font-family: "Inter", sans-serif;
        font-size: 1.2rem;
        font-weight: 600;
        color: #60a5fa;
    }

    .play-btn {
        background: #2563eb;
        color: white;
        border: none;
        padding: 6px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 600;
        transition: background 0.2s;
    }

    .play-btn:hover {
        background: #3b82f6;
    }

    .slider {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 6px;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
        outline: none;
    }

    .slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 18px;
        height: 18px;
        background: #3b82f6;
        cursor: pointer;
        border-radius: 50%;
        box-shadow: 0 0 10px rgba(59, 130, 246, 0.5);
    }
</style>
