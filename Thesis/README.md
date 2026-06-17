# Synapse — FYP Thesis (Overleaf project)

Upload this whole `Thesis/` folder to Overleaf (New Project → Upload Project → zip it first),
set the compiler to **pdfLaTeX**, and compile `main.tex`.

## Structure
- `main.tex` — preamble (format-exact: Times New Roman 12pt, 1.5 spacing, chapter 20pt bold,
  section 14pt bold, subsection 14pt regular, 12pt above, IEEE citations) + document order.
- `frontmatter/` — title pages, certificate of approval, declaration, acknowledgement, dedication,
  abstract.
- `chapters/` — the 8 chapters + abbreviations/glossary.
- `figures/` — product screenshots, the institute logo, and the generated diagrams (`fig_*.png`).
- `diagrams/` — the diagram scripts. Each describes boxes + arrows on a pixel canvas
  (`html_dsl.py`), renders to clean HTML/CSS, and screenshots it to a crisp 2x PNG with
  headless Chrome (the same way the reference theses were drawn). Re-run to regenerate:
  `cd diagrams && python d01_architecture.py` (needs Google Chrome or Microsoft Edge installed).
- `references.bib` — IEEE bibliography.

## Notes
- Times New Roman is provided through `newtxtext`/`newtxmath` (metrically identical, works on any
  Overleaf install). If you have the real TNR font on Overleaf, you can switch to XeLaTeX + fontspec.
- `\bibliographystyle{IEEEtran}` + `\bibliography{references}`. Run pdfLaTeX → biber/bibtex → pdfLaTeX
  twice (Overleaf does this automatically).
