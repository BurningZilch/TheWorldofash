import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
    const url = new URL(request.url);
    const params = url.searchParams;
    const timeIndexStr = params.get('timeIndex');
    const timeIndex = timeIndexStr ? parseInt(timeIndexStr) : 3310;

    // Time calculation simulating 1750 to 2025 (approx 3311 months)
    // Each index is 1 month.
    const startYear = 1750;
    const currentYear = startYear + Math.floor(timeIndex / 12);
    const currentMonth = (timeIndex % 12) + 1;
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const timeString = `${monthNames[currentMonth - 1]} ${currentYear}`;

    // Mock data generation simulating a downsampled Zarr slice
    const features = [];
    const step = 4.0; // Slightly coarser for faster updates during animation

    // Global warming trend (approx 1.5 degrees over 275 years)
    const warmingBase = (timeIndex / 3311) * 2.0;

    // Seasonal cycle (Northern Hemisphere simplified)
    const seasonPhase = (currentMonth - 1) / 12 * 2 * Math.PI;
    const seasonEffect = Math.sin(seasonPhase - Math.PI / 2); // Lowest in Jan, highest in July

    for (let lat = -90; lat <= 90; lat += step) {
        for (let lng = -180; lng < 180; lng += step) {
            // Base temp depends on latitude
            const baseTemp = 30 - Math.abs(lat) * 0.6;

            // Regional variation
            const regional = Math.sin(lng * Math.PI / 180) * 3 + Math.cos(lat * Math.PI / 90) * 2;

            // Combine effects
            // Seasonal effect is stronger at higher latitudes
            const seasonal = seasonEffect * (Math.abs(lat) / 90) * 15;

            const temp = baseTemp + warmingBase + regional + seasonal;

            features.push({
                type: "Feature",
                properties: {
                    temp: Math.round(temp * 10) / 10,
                    mag: Math.max(0, Math.min(1, (temp + 25) / 65)) // Normalized 0-1
                },
                geometry: {
                    type: "Point",
                    coordinates: [lng, lat]
                }
            });
        }
    }

    const geojson = {
        type: "FeatureCollection",
        metadata: {
            source: "zarr/.Land_TAVG_Gridded_0p25deg.zarr",
            description: "Time-indexed Temperature Simulation",
            units: "degree C",
            resolution: `${step}deg`,
            time: timeString,
            timeIndex: timeIndex
        },
        features: features
    };

    return new Response(JSON.stringify(geojson), {
        status: 200,
        headers: {
            "Content-Type": "application/json"
        }
    });
};
