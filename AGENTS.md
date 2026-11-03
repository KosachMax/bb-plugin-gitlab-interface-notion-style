# Agent notes

- Any UI change follows [docs/design/DESIGN.md](docs/design/DESIGN.md). Use the components in `components/notion.tsx`; do not add one-off font sizes, tints, radii or button heights. If a component is missing, add it there first.
- Before finishing: `npm run typecheck`, `npm test`, `bb plugin build`.
- Versions stay on 1.x: the BB marketplace entry installs `^1.0.0`, so a 2.x tag would never reach users. Release from `main` as the next 1.x (`v1.3.4`, `v1.4.0`, …). Never tag 2.x.
