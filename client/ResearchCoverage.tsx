import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { researchAgents, researchAgentLabels, type ResearchAgent, type ResearchReport } from "../shared/research";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "./components/ui/chart";

export default function ResearchCoverage({ report, onSelect }: { report: ResearchReport; onSelect: (agent: ResearchAgent) => void }) {
  const data = researchAgents.map((agent) => ({
    area: researchAgentLabels[agent],
    findings: report.steps.filter((step) => step.agent === agent).reduce((count, step) => count + step.findings.length, 0),
  }));
  return <div className="research-coverage">
    <p>Accepted findings by research area. More findings do not mean better business performance. Select a bar or use the area buttons below.</p>
    <ChartContainer className="coverage-chart" config={{ findings: { label: "Accepted findings", color: "var(--chart-1)" } }}>
      <BarChart accessibilityLayer data={data} layout="vertical" margin={{ left: 0, right: 24 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="area" width={142} tickLine={false} axisLine={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        <Bar dataKey="findings" fill="var(--color-findings)" radius={[0, 4, 4, 0]} isAnimationActive={false}
          onClick={(_entry, index) => onSelect(researchAgents[index])} />
      </BarChart>
    </ChartContainer>
    <table className="sr-only"><caption>Accepted findings by area</caption><thead><tr><th>Area</th><th>Findings</th></tr></thead>
      <tbody>{data.map((item) => <tr key={item.area}><th scope="row">{item.area}</th><td>{item.findings}</td></tr>)}</tbody></table>
  </div>;
}
