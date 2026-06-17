"""Figure: the agent-mode pipeline (plan, clarify, acquire, build, render)."""
from html_dsl import Diagram

d = Diagram(1280, 560, "Agent Mode — From a Goal to an Artefact")

goal   = d.box(120, 150, 190, 80, "User goal", "libraries / uploaded file + request", "navy")
plan   = d.box(360, 150, 190, 86, "Plan", "decide intent, data needs, artefacts", "blue")
clarify= d.box(360, 380, 190, 80, "Ask to clarify", "only if the request is ambiguous", "rose")
acquire= d.box(600, 150, 190, 86, "Acquire data", "exact re-parse + retrieval extraction", "teal")
spec   = d.box(840, 150, 190, 86, "Build the spec", "chart (Vega-Lite) or diagram (Mermaid)", "teal")
valid  = d.box(840, 380, 190, 80, "Validate & repair", "check fields, one repair pass", "violet")
render = d.box(1080, 150, 180, 86, "Render", "interactive view + downloadable file", "amber")
narr   = d.box(1080, 380, 180, 80, "Narrate", "explain result, note assumptions", "slate")

d.arrow(goal, "r", plan, "l")
d.arrow(plan, "b", clarify, "t", "if ambiguous")
d.arrow(clarify, "r", acquire, "l", "answered", elbow="v")
d.arrow(plan, "r", acquire, "l")
d.arrow(acquire, "r", spec, "l")
d.arrow(spec, "b", valid, "t")
d.arrow(valid, "r", render, "l", elbow="v")
d.arrow(spec, "r", render, "l")
d.arrow(render, "b", narr, "t")

d.note(120, 320, "Data values are bound to the\nchart in code, never written\nby the model, so the numbers\nalways match the source file.", fs=11.5)

d.save("fig_agent_flow.png")
