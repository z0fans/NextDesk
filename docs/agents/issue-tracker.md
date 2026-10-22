# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are stored individually at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- Triage state is recorded as a `Status:` line near the top
- Comments are appended under a `## Comments` heading
- Specs and issues remain local unless the user explicitly requests Git publication

## Publishing

When a skill says “publish to the issue tracker”, create the corresponding file under `.scratch/<feature-slug>/`.
