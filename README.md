# Stride

**Upload any plan. Walk it before it exists.**

Stride turns a 2D plan image — a residential floor plan, an office layout, or a land/site
plan — into a first-person walkable 3D world. Claude vision reads the drawing (walls, doors,
windows, rooms, scale, plot boundaries), and Stride builds a physically-based, fully lit,
furnished, audible world around you.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5183
```

That's it for the demo: the three bundled sample plans (apartment, office floor, land parcel)
run entirely locally, no API key needed.

### Enabling real plan uploads

Uploads are analyzed by the Claude API through a small server proxy (your key never reaches
the browser):

```bash
cp .env.example .env
# put your key from https://console.anthropic.com in .env:
# ANTHROPIC_API_KEY=sk-ant-...
npm run dev
```

Optionally set `ANTHROPIC_MODEL` (defaults to `claude-sonnet-5`).

### Deploying

The repo is Vercel-ready: `api/analyze.js` is a serverless function using the same handler as
local dev. Set `ANTHROPIC_API_KEY` in the Vercel project env vars and deploy.

## Controls

| Input | Action |
|---|---|
| Click "Click to walk" | capture the mouse |
| W A S D / arrows | move |
| Mouse | look |
| Shift | run |
| E or click | open/close doors, flip light switches |
| Esc | release the mouse |
| Touch devices | left thumb joystick to move, right thumb drag to look, tap to interact |

The HUD tracks your **steps and distance** (that's how a body understands a space), names the
room you're in, shows a **north-up minimap** (bottom-right) with your position and view cone,
and has a **time-of-day slider** — drag it to sunset and the whole world relights; interior
lamps take over at night. Press **Esc** any time to free the cursor and use the controls — a
"Resume walking" button brings you back. If the Pointer Lock API is unavailable (some
embedded browsers), Stride falls back to drag-to-look automatically.

## What makes it look real

- **Real PBR texture sets** (ambientCG, CC0): color/normal/roughness/AO for wood floors,
  carpet, tiles, plaster, concrete, grass, asphalt — tiled in world units so scale is honest.
- **Planar-reflective floors** (wood/tile) on the High quality tier.
- **Sun + sky simulation**: physical sky shader, sun position/color/intensity driven by the
  hour, moon + stars at night, and an offline-generated environment map recaptured as the
  light changes — reflections always match the sky.
- **Per-room lighting that behaves like lighting**: fixture grids sized to the room (pendants,
  flush domes, office LED panels), a downward key light plus a faked-GI bounce fill, real
  clickable wall switches placed beside each room's door, emissive fixtures picked up by bloom.
- **Soft shadows, N8AO ambient occlusion, ACES tone mapping, vignette.**
- **Auto-furnishing by detected room type** — beds, wardrobes, sofas, TV, kitchen runs,
  bathroom fixtures, desk rows, meeting tables — placed against real walls, clear of door
  swings, verified against the room's actual footprint, with collision.
- **Procedural audio, zero samples**: footsteps tuned per surface (wood knock, tile click,
  carpet thud, grass rustle, gravel crunch), room tone / HVAC / wind / birds by day /
  crickets by night, door creaks and latch clicks, switch clicks — all synthesized in
  WebAudio and routed through a reverb sized to the room you're standing in.
- **Quality tiers** (High/Medium/Low) with an FPS watchdog that steps down gracefully instead
  of stuttering; manual override in the HUD.

## How it works

```
image ──► /api/analyze (Claude vision, forced tool-call JSON)
              │  walls, doors, windows, rooms, dimensions, scale,
              │  plan type (floor / office / site), site boundary
              ▼
        /api/analyze phase=refine (verification pass)
              │  Claude re-checks its extraction against the image:
              │  missed/false walls, sealed rooms, missed doors, scale
              ▼
      src/lib/planProcess.js
              │  px→meters, wall snapping/merging/axis alignment,
              │  double-trace merging, T-junction gap closing,
              │  scale cross-check against door widths,
              │  scale fallbacks (labels → door width → estimate),
              │  10 cm grid flood-fill → real room footprints,
              │  passable door widths, doorways punched into any
              │  room the connectivity graph says you couldn't enter
              ▼
          ScenePlan  ◄─── also produced directly by bundled samples
              │
              ▼
   React Three Fiber world
   Walls · Floors · Ceiling · Doors · RoomLights · Furniture
   (interiors)   /   terrain · boundary pegs · road · trees (sites)
```

The grid flood-fill is the load-bearing trick: it reconstructs true room shapes from imperfect
wall data, and the same grid then powers per-room floor materials, furniture placement bounds,
"which room am I in" (for the HUD, ambience profile and reverb), and light-switch placement.

## Project layout

```
api/analyze.js            Vercel serverless proxy (Claude API)
server/planAnalysis.js    shared analysis prompt + schema + call
scripts/gen-sample-svgs.mjs  renders sample fixtures to plan-style SVGs
src/
  lib/    planProcess, analyzeClient, textures, audio, interact, roomTypes
  scene/  Experience, SunSky, Walls, Floors, Ceiling, Doors, RoomLights,
          Furniture (+ furniture/pieces), Interior, Exterior, Player
  ui/     Landing, HUD
  data/   samples (fixtures for the keyless demo)
public/
  textures/  bundled CC0 PBR sets (ambientCG)
  samples/   generated sample plan drawings
```

## Notes

- Upload formats: PNG, JPG, WebP, SVG (PDF: export a page as an image for now).
- Plans with clear, dark wall lines on a light background analyze best; printed dimensions or
  an area label make the scale exact.
- Textures are © ambientCG, licensed CC0.
