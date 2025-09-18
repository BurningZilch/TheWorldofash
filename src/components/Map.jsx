import { useEffect, useRef } from "react";
import * as d3 from "d3";
import { feature } from "topojson-client";

export default function Map() {
  const ref = useRef(null);

  useEffect(() => {
    const width = 800;
    const height = 400;

    const svg = d3.select(ref.current)
      .attr("width", width)
      .attr("height", height);

    svg.selectAll("*").remove();

    const projection = d3.geoNaturalEarth1()
      .scale(160)
      .translate([width / 2, height / 2]);

    const path = d3.geoPath().projection(projection);

    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((data) => {
        const countries = feature(data, data.objects.countries);

        svg.append("g")
          .selectAll("path")
          .data(countries.features)
          .join("path")
          .attr("d", path)
          .attr("fill", "#69b3a2")
          .attr("stroke", "#333");
      })
      .catch((err) => console.error("Map load error:", err));
  }, []);

  return <svg ref={ref}></svg>;
}

