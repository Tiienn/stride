// Shared plan-analysis logic used by both the Vercel function (api/analyze.js)
// and the Vite dev middleware. Runs server-side only — holds the API key.
import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_MODEL = 'claude-sonnet-5'

// The tool schema doubles as the output contract: forcing tool use makes the
// model return validated JSON instead of prose. Pixel space, top-left origin.
const ANALYSIS_TOOL = {
  name: 'record_plan_analysis',
  description: 'Record the structured analysis of an architectural plan image.',
  input_schema: {
    type: 'object',
    required: ['planType', 'confidence', 'scale'],
    properties: {
      planType: {
        type: 'string',
        enum: ['floor_residential', 'floor_office', 'site'],
        description:
          'floor_residential: interior floor plan of a home/apartment. floor_office: interior plan of a workplace (offices, meeting rooms, open plan). site: a land/plot/site plan showing a parcel boundary, possibly with building footprints, roads, setbacks.',
      },
      confidence: { type: 'number', description: '0-1 confidence in the classification' },
      planName: { type: 'string', description: 'Short human name, e.g. "2-Bedroom Apartment", "Open-Plan Office", "Corner Plot"' },
      imageSize: {
        type: 'object',
        properties: { width: { type: 'number' }, height: { type: 'number' } },
      },
      walls: {
        type: 'array',
        description: 'Interior plans only. Every wall segment, center-line, in pixels. Include ALL segments, even short ones.',
        items: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            start: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            end: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            thickness: { type: 'number', description: 'pixels' },
            isExterior: { type: 'boolean' },
          },
        },
      },
      doors: {
        type: 'array',
        description: 'Doors and open doorways. Quarter-circle arcs are hinged doors; plain gaps are doorways.',
        items: {
          type: 'object',
          required: ['center', 'width'],
          properties: {
            center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            width: { type: 'number', description: 'pixels' },
            kind: { type: 'string', enum: ['hinged', 'sliding', 'doorway', 'entrance'] },
            wallIndex: { type: 'number' },
          },
        },
      },
      windows: {
        type: 'array',
        items: {
          type: 'object',
          required: ['center', 'width'],
          properties: {
            center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            width: { type: 'number', description: 'pixels' },
            wallIndex: { type: 'number' },
          },
        },
      },
      rooms: {
        type: 'array',
        description: 'Interior plans only. One entry per enclosed room. The center MUST be a point inside the room, well clear of walls.',
        items: {
          type: 'object',
          required: ['name', 'center'],
          properties: {
            name: { type: 'string', description: 'Label from the plan, or inferred, e.g. "Bedroom 2"' },
            type: {
              type: 'string',
              enum: ['living', 'bedroom', 'kitchen', 'bathroom', 'dining', 'hall', 'office', 'meeting', 'reception', 'storage', 'balcony', 'garage', 'generic'],
            },
            center: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            labeledArea: { type: 'number', description: 'm² if printed on the plan' },
          },
        },
      },
      siteBoundary: {
        type: 'array',
        description: 'Site plans only. The parcel boundary polygon in pixels, ordered, closed implicitly.',
        items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      siteArea: { type: 'number', description: 'Site plans: parcel area in m² if labeled' },
      roadSide: {
        type: 'object',
        description: 'Site plans: the boundary edge that faces the access road, if identifiable.',
        properties: {
          start: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          end: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        },
      },
      dimensions: {
        type: 'array',
        description: 'Every printed dimension with its pixel endpoints — used to compute scale.',
        items: {
          type: 'object',
          properties: {
            value: { type: 'number' },
            unit: { type: 'string', enum: ['m', 'mm', 'cm', 'ft'] },
            startPixel: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            endPixel: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      scale: {
        type: 'object',
        required: ['pixelsPerMeter', 'confidence', 'source'],
        properties: {
          pixelsPerMeter: { type: 'number' },
          confidence: { type: 'number' },
          source: { type: 'string', enum: ['dimension_label', 'total_area', 'door_width', 'estimated'] },
        },
      },
    },
  },
}

const SYSTEM_PROMPT = `You are an expert architectural plan analyzer. You extract precise structured data from 2D plan images for 3D reconstruction. A person will literally WALK through the 3D model built from your output — every wall you miss becomes a hole in their world, every wall you invent blocks their path, and every door you miss seals a room forever.

CRITICAL RULES:
1. All coordinates are PIXELS from the image's top-left corner.
2. Walls are defined by their CENTER LINE, not edges. One wall = ONE segment. Never trace the two drawn faces of a wall as two separate parallel segments.
3. First classify the plan: an interior floor plan (residential or office) vs a site/land plan (parcel boundary, plot). Site plans show property lines, lot dimensions, north arrows, setbacks, roads — not interior walls.
4. Doors: quarter-circle arc = hinged door. Gap with no arc = doorway. The building's main entry door has kind "entrance". Real doors are 0.7–1.0 m wide — sanity-check your pixel widths against the scale.
5. Windows: short parallel lines / thin rectangles crossing exterior walls.
6. Scale, in priority order: (a) printed dimension labels — bare numbers like 3670 are MILLIMETERS, decimals like 5.37 are METERS; (b) printed total area worked backward; (c) standard door width 0.9m; (d) estimate. Report source and confidence honestly.
7. Room centers must be INSIDE the room, far from any wall — they seed a flood fill.
8. Site plans: trace the parcel boundary polygon precisely, note the road-facing edge if drawn.

METHOD for interior plans — work systematically, do not eyeball the whole drawing at once:
A. Read every text label and printed dimension first; establish the scale.
B. List every room you can identify (from labels, or from fixtures: a room with a toilet symbol is a bathroom, with a counter run a kitchen). Include closets, hallways, balconies — small rooms count.
C. Trace the building's exterior outline as a CLOSED loop of wall segments. Exterior walls are the thick ones (15–25 px typical).
D. Then trace the interior partition walls room by room (8–15 px typical). Every wall endpoint must either share exact coordinates with another wall's endpoint (corner) or land exactly ON another wall's line (T-junction). A floating, unconnected wall end is almost always a tracing error — reconsider it.
E. Walk your room list: every room MUST have at least one door or open doorway in its walls. If a room in your extraction has none, you missed an opening — look again at gaps and arcs along that room's walls before recording.
F. Openings sit INSIDE walls: a door's center must lie on a wall segment you traced, with wall continuing on both sides (or ending at a corner).

DO NOT trace as walls: furniture, kitchen counters, wardrobes, stairs, dimension lines, extension lines, hatching, text, door leaves or their swing arcs. If a "wall" is thinner than every other line and touches nothing, it is probably a dimension line.

Record your analysis with the record_plan_analysis tool. Be exhaustive with walls — a missed wall ruins the 3D model.`

// Second pass: the model reviews its own extraction against the image and
// returns a small diff of corrections — much cheaper/faster than re-emitting
// the full analysis, which matters inside serverless time budgets.
const CORRECTIONS_TOOL = {
  name: 'record_plan_corrections',
  description: 'Record corrections to a previous plan analysis after re-checking it against the image.',
  input_schema: {
    type: 'object',
    required: ['summary'],
    properties: {
      summary: { type: 'string', description: 'One or two sentences on what was wrong, or "extraction verified" if nothing.' },
      missedWalls: { type: 'array', description: 'Walls present in the image but absent from the analysis.', items: ANALYSIS_TOOL.input_schema.properties.walls.items },
      falseWallIndexes: { type: 'array', description: '0-based indexes into the analysis walls array of walls that do NOT exist in the image (furniture, dimension lines, double-traced faces).', items: { type: 'number' } },
      adjustedWalls: {
        type: 'array',
        description: 'Walls whose endpoints are significantly wrong (off by more than ~15px).',
        items: {
          type: 'object',
          required: ['index', 'start', 'end'],
          properties: {
            index: { type: 'number' },
            start: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            end: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      missedDoors: { type: 'array', items: ANALYSIS_TOOL.input_schema.properties.doors.items },
      falseDoorIndexes: { type: 'array', items: { type: 'number' } },
      missedWindows: { type: 'array', items: ANALYSIS_TOOL.input_schema.properties.windows.items },
      falseWindowIndexes: { type: 'array', items: { type: 'number' } },
      missedRooms: { type: 'array', items: ANALYSIS_TOOL.input_schema.properties.rooms.items },
      scaleCorrection: ANALYSIS_TOOL.input_schema.properties.scale,
    },
  },
}

const REFINE_SYSTEM_PROMPT = `You are re-checking a structured extraction of an architectural plan against the original image. The extraction will drive a walkable 3D model, so errors have physical consequences: a missed wall is a hole, an invented wall blocks a corridor, a missed door seals a room.

Check, in order:
1. FALSE WALLS: walls in the extraction that are actually furniture, counters, stairs, dimension lines, text, door swing arcs — or a second trace of a wall already listed (two parallel segments ~one wall-thickness apart along the same span are one double-traced wall: keep one index, report the other as false).
2. MISSED WALLS: real walls absent from the extraction. Compare room by room — every room on the drawing must be fully enclosed by extracted walls (with doors as the only gaps).
3. DOORS: every room must be reachable — each room needs at least one door/doorway in the extraction. Find the openings for any sealed room. Also drop doors that don't exist.
4. ROOMS: any labeled or clearly-drawn room missing from the extraction's room list.
5. SCALE: spot-check one printed dimension against its pixel length; correct the scale if it's off by more than ~10%. Bare numbers like 3670 are millimeters.

Report ONLY genuine discrepancies — do not nudge coordinates that are roughly right. If the extraction is faithful, record an empty correction with summary "extraction verified". Always respond via the record_plan_corrections tool.`

export async function analyzePlanImage(body, opts = {}) {
  if (!opts.apiKey) {
    const err = new Error(
      'No ANTHROPIC_API_KEY configured on the server. Add it to .env (local) or your Vercel env vars — or use a sample plan, which needs no key.'
    )
    err.statusCode = 503
    throw err
  }
  const { image, mediaType } = body || {}
  if (!image || typeof image !== 'string') {
    const err = new Error('Missing image (base64) in request body')
    err.statusCode = 400
    throw err
  }
  if (body.phase === 'refine') return refinePlanAnalysis(body, opts)
  const { apiKey, model } = opts

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    temperature: 0, // extraction, not creativity — same plan must give the same walls
    system: SYSTEM_PROMPT,
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: 'record_plan_analysis' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image },
          },
          {
            type: 'text',
            text: 'Analyze this plan. Classify it, then extract every element per your instructions, and record the result.',
          },
        ],
      },
    ],
  })

  const toolUse = response.content.find((c) => c.type === 'tool_use')
  if (!toolUse) {
    const err = new Error('Model returned no structured analysis')
    err.statusCode = 502
    throw err
  }
  return { analysis: toolUse.input, model: response.model, usage: response.usage }
}

// Verification pass: show the model the image again alongside its own
// first-pass extraction (with indexes), collect a correction diff, and merge
// it into the analysis. Runs as a separate request so each pass gets its own
// serverless time budget.
async function refinePlanAnalysis(body, { apiKey, model }) {
  const { image, mediaType, analysis } = body
  if (!analysis || typeof analysis !== 'object') {
    const err = new Error('Missing analysis to refine')
    err.statusCode = 400
    throw err
  }

  const indexed = {
    ...analysis,
    walls: (analysis.walls || []).map((w, i) => ({ index: i, ...w })),
    doors: (analysis.doors || []).map((d, i) => ({ index: i, ...d })),
    windows: (analysis.windows || []).map((w, i) => ({ index: i, ...w })),
  }

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 8000,
    temperature: 0,
    system: REFINE_SYSTEM_PROMPT,
    tools: [CORRECTIONS_TOOL],
    tool_choice: { type: 'tool', name: 'record_plan_corrections' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image },
          },
          {
            type: 'text',
            text: `Here is the extraction to verify against the image above (elements carry their index):\n\n${JSON.stringify(indexed)}\n\nRe-check it per your instructions and record the corrections.`,
          },
        ],
      },
    ],
  })

  const toolUse = response.content.find((c) => c.type === 'tool_use')
  if (!toolUse) {
    const err = new Error('Model returned no corrections')
    err.statusCode = 502
    throw err
  }
  return {
    analysis: applyCorrections(analysis, toolUse.input),
    corrections: toolUse.input.summary,
    model: response.model,
    usage: response.usage,
  }
}

function applyCorrections(analysis, c) {
  const dropByIndex = (arr, indexes) => {
    const drop = new Set((indexes || []).filter((i) => Number.isInteger(i)))
    return (arr || []).filter((_, i) => !drop.has(i))
  }
  const walls = (analysis.walls || []).map((w, i) => {
    const adj = (c.adjustedWalls || []).find((a) => a?.index === i && a.start && a.end)
    return adj ? { ...w, start: adj.start, end: adj.end } : w
  })
  return {
    ...analysis,
    walls: [...dropByIndex(walls, c.falseWallIndexes), ...(c.missedWalls || [])],
    doors: [...dropByIndex(analysis.doors, c.falseDoorIndexes), ...(c.missedDoors || [])],
    windows: [...dropByIndex(analysis.windows, c.falseWindowIndexes), ...(c.missedWindows || [])],
    rooms: [...(analysis.rooms || []), ...(c.missedRooms || [])],
    scale: c.scaleCorrection?.pixelsPerMeter > 0 ? c.scaleCorrection : analysis.scale,
  }
}
