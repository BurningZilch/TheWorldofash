<script>
  import { onMount } from "svelte";
  import * as d3 from "d3";
  import { feature } from "topojson-client";
  import versor from "versor";

  import worldData from "../assets/world-110m.json";

  let container;

  onMount(() => {
    const width = 800;
    const height = 800;

    const projection = d3.geoOrthographic()
      .scale((width / 2) - 10)
      .translate([width / 2, height / 2])
      .clipAngle(90);

    const path = d3.geoPath().projection(projection);
    const graticule = d3.geoGraticule10();

    const svg = d3.select(container)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .style("cursor", "grab");

    // Sphere (background)
    const sphere = svg.append("path")
      .datum({ type: "Sphere" })
      .attr("fill", "#eef")
      .attr("stroke", "#000")
      .attr("stroke-width", 1);

    // Graticule
    const grid = svg.append("path")
      .datum(graticule)
      .attr("fill", "none")
      .attr("stroke", "#999")
      .attr("stroke-width", 0.5)
      .attr("stroke-opacity", 0.5);

    // Countries
    const countries = feature(worldData, worldData.objects.countries).features;

    const land = svg.selectAll("path.country")
      .data(countries)
      .enter()
      .append("path")
      .attr("class", "country")
      .attr("fill", "#69b3a2")
      .attr("stroke", "#333")
      .attr("stroke-width", 0.5);

    // ---- Versor dragging state ----
    let v0, r0, q0;

    const drag = d3.drag()
      .on("start", (event) => {
        v0 = versor.cartesian(projection.invert([event.x, event.y]));
        r0 = projection.rotate();
        q0 = versor.rotation(r0);
        svg.style("cursor", "grabbing");
      })
      .on("drag", (event) => {
        const v1 = versor.cartesian(projection.invert([event.x, event.y]));
        const q1 = versor.multiply(q0, versor.delta(v0, v1));
        const r1 = versor.rotation(q1);
        projection.rotate(r1);
        redraw();
      })
      .on("end", () => {
        svg.style("cursor", "grab");
      });

    svg.call(drag);

    // ---- Zoom (scale globe) ----
    const zoom = d3.zoom()
      .scaleExtent([0.5, 8])
      .on("zoom", (event) => {
        projection.scale((width / 2 - 10) * event.transform.k);
        redraw();
      });

    svg.call(zoom);

    // ---- Redraw function ----
    function redraw() {
      sphere.attr("d", path);
      grid.attr("d", path);
      land.attr("d", path);
    }

    // Initial draw
    redraw();
  });
</script>

<div bind:this={container}></div>

<style>
  div {
    display: flex;
    justify-content: center;
    align-items: center;
  }
  svg {
    background: #eef;
    border-radius: 12px;
  }
</style>
