<script>
    import { onMount } from "svelte";
    import * as d3 from "d3";
    import { feature, mesh } from "topojson-client";
    import versor from "versor";

    import land50mTopo from "../assets/land-50m.json";
    import countriesTopo from "../assets/countries-110m.json"; // download this too

    let container;

    onMount(() => {
        const width = 800;
        const height = 500;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        container.appendChild(canvas);

        const context = canvas.getContext("2d");

        // Projection
        const projection = d3.geoOrthographic()
            .scale(240)
            .translate([width / 2, height / 2]);
        const path = d3.geoPath(projection, context);

        const sphere = { type: "Sphere" };
        const land = feature(land50mTopo, land50mTopo.objects.land);
        const borders = mesh(countriesTopo, countriesTopo.objects.countries, (a, b) => a !== b);
        const graticule = d3.geoGraticule10();

        function render() {
            context.clearRect(0, 0, width, height);

            // Ocean
            context.beginPath(); path(sphere);
            context.fillStyle = "#d0e7f9"; context.fill();

            // Land
            context.beginPath(); path(land);
            context.fillStyle = "#98c27a"; context.fill();

            // Country borders
            context.beginPath(); path(borders);
            context.strokeStyle = "#333";
            context.lineWidth = 0.5;
            context.stroke();

            // Graticule (stronger grid)
            context.beginPath(); path(graticule);
            context.strokeStyle = "rgba(80,80,80,0.4)";
            context.lineWidth = 0.5;
            context.stroke();

            // Sphere outline
            context.beginPath(); path(sphere);
            context.strokeStyle = "#000";
            context.lineWidth = 1;
            context.stroke();
        }

        render();

        // --- Drag-to-rotate ---
        let v0, q0, r0;

        function dragstarted(event) {
            v0 = versor.cartesian(projection.invert([event.x, event.y]));
            r0 = projection.rotate();
            q0 = versor(r0);
        }

        function dragged(event) {
            const v1 = versor.cartesian(projection.rotate(r0).invert([event.x, event.y]));
            const q1 = versor.multiply(q0, versor.delta(v0, v1));
            projection.rotate(versor.rotation(q1));
            render();
        }

        d3.select(canvas)
            .call(d3.drag()
                .on("start", dragstarted)
                .on("drag", dragged)
            );

        // --- Zoom-to-scale ---
        function zoomed(event) {
            const newScale = event.transform.k * 240; // 240 = base scale
            projection.scale(newScale);
            render();
        }

        const zoom = d3.zoom()
            .scaleExtent([0.5, 50]) // allow closer zoom
            .on("zoom", zoomed);

        d3.select(canvas).call(zoom);
    });
</script>

<div bind:this={container}></div>
