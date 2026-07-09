// Shared plan-analysis logic used by both the Vercel function (api/analyze.js)
// and the Vite dev middleware. Runs server-side only — holds the API key.
import Anthropic from '@anthropic-ai/sdk'

const DEFAULT_MODEL = 'claude-sonnet-5'

// The tool schema doubles as the output contract: forcing tool use makes the
// model return validated JSON instead of prose. Pixel space, top-left origin.
// strict: true guarantees the tool_use.input matches this schema exactly, so the
// pixel-space parsing downstream never has to defend against a malformed shape.
// Strict mode requires every object node to carry additionalProperties:false and
// a `required` listing all its keys; fields that are genuinely absent on some
// plans (site-only data, un-printed areas, unlocatable pixels) are required-but-
// nullable so the model can emit null instead of fabricating a value.
const ANALYSIS_TOOL = {
  name: 'record_plan_analysis',
  description: 'Record the structured analysis of an architectural plan image.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['planType', 'confidence', 'planName', 'imageSize', 'walls', 'doors', 'windows', 'rooms', 'furniture', 'siteBoundary', 'siteArea', 'roadSide', 'dimensions', 'scale'],
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
        additionalProperties: false,
        required: ['width', 'height'],
        properties: { width: { type: 'number' }, height: { type: 'number' } },
      },
      walls: {
        type: 'array',
        description: 'Interior plans only. Every wall segment, center-line, in pixels. Include ALL segments, even short ones.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['start', 'end', 'thickness', 'isExterior'],
          properties: {
            start: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            end: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
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
          additionalProperties: false,
          required: ['center', 'width', 'kind', 'wallIndex', 'hingePixel', 'swingPixel'],
          properties: {
            center: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            width: { type: 'number', description: 'pixels' },
            kind: { type: 'string', enum: ['hinged', 'sliding', 'doorway', 'entrance'] },
            // nullable: the model may not reliably identify which wall the door sits on (unused downstream).
            wallIndex: { type: ['number', 'null'] },
            // nullable: the leaf's pivot — the CENTER of the quarter-circle swing arc (where its two
            // straight edges meet / where the leaf line attaches to the wall). null for sliding doors,
            // plain doorways, or when no arc is readable.
            hingePixel: { type: ['object', 'null'], additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            // nullable: a point in the middle of the swept region (≈ the arc's midpoint, halfway between
            // the leaf's open and closed positions); marks which side the door opens into. null when no arc.
            swingPixel: { type: ['object', 'null'], additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      windows: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['center', 'width', 'wallIndex'],
          properties: {
            center: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            width: { type: 'number', description: 'pixels' },
            // nullable: as with doors, the host wall may be undetermined (unused downstream).
            wallIndex: { type: ['number', 'null'] },
          },
        },
      },
      rooms: {
        type: 'array',
        description: 'Interior plans only. One entry per enclosed room. The center MUST be a point inside the room, well clear of walls.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'type', 'center', 'labeledArea'],
          properties: {
            name: { type: 'string', description: 'Label from the plan, or inferred, e.g. "Bedroom 2"' },
            type: {
              type: 'string',
              enum: ['living', 'bedroom', 'kitchen', 'bathroom', 'dining', 'hall', 'office', 'meeting', 'reception', 'storage', 'balcony', 'garage', 'generic'],
            },
            center: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            // nullable: only present when the area is printed on the plan — fabricating it
            // would corrupt the area-based scale calibration downstream.
            labeledArea: { type: ['number', 'null'], description: 'm² if printed on the plan' },
          },
        },
      },
      furniture: {
        type: 'array',
        description: 'Interior plans only. Every recognizable furniture/fixture symbol, one entry each.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'center', 'width', 'depth', 'rotationDeg'],
          properties: {
            type: {
              type: 'string',
              enum: ['bed', 'sofa', 'armchair', 'dining_table', 'coffee_table', 'desk', 'chair', 'wardrobe', 'bookshelf', 'tv_unit', 'kitchen_run', 'fridge', 'sink', 'hob', 'toilet', 'shower', 'bathtub', 'washbasin', 'plant', 'rug'],
            },
            center: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            width: { type: 'number', description: "px, along the symbol's local long axis (local x) BEFORE rotation" },
            depth: { type: 'number', description: "px, along the symbol's local y BEFORE rotation" },
            // nullable: orientation is often ambiguous for square-ish symbols; emit null rather than guess.
            rotationDeg: { type: ['number', 'null'], description: '0 = long axis horizontal (along image x); positive = clockwise in image space; null if unclear' },
          },
        },
      },
      siteBoundary: {
        type: 'array',
        description: 'Site plans only. The parcel boundary polygon in pixels, ordered, closed implicitly.',
        items: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
      },
      // nullable: only present when a parcel area is labeled (site plans).
      siteArea: { type: ['number', 'null'], description: 'Site plans: parcel area in m² if labeled' },
      roadSide: {
        // nullable: absent on interior plans, and on site plans when no road edge is identifiable.
        type: ['object', 'null'],
        description: 'Site plans: the boundary edge that faces the access road, if identifiable.',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          end: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
        },
      },
      dimensions: {
        type: 'array',
        description: 'Every printed dimension with its pixel endpoints — used to compute scale.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['value', 'unit', 'startPixel', 'endPixel'],
          properties: {
            value: { type: 'number' },
            unit: { type: 'string', enum: ['m', 'mm', 'cm', 'ft'] },
            // nullable: the model may read a dimension's value/unit but be unable to pin its
            // exact pixel endpoints; downstream already skips dimensions missing either.
            startPixel: { type: ['object', 'null'], additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            endPixel: { type: ['object', 'null'], additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      scale: {
        type: 'object',
        additionalProperties: false,
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
4. Doors: quarter-circle arc = hinged door. Gap with no arc = doorway. The building's main entry door has kind "entrance". Real doors are 0.7–1.0 m wide — sanity-check your pixel widths against the scale. For a hinged door, also give hingePixel (the arc's CENTER, where the leaf pivots against the wall) and swingPixel (a point mid-arc, halfway through the leaf's sweep) so the 3D door hinges on the right side and opens the right way; both are null for sliding doors, plain doorways, or when the arc is unreadable.
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
G. Identify every furniture and fixture symbol and record its type, center, size and rotation in furniture: beds, sofas, armchairs, a dining table WITH its surrounding chairs as ONE dining_table entry, coffee tables, desks, chairs, wardrobes (often a rectangle with an X through it), bookshelves, TV units, kitchen counter runs, fridges, sinks, hob/stove burner circles, toilets, showers (often a square with an X or diagonal hatch in a bathroom corner), bathtubs, washbasins, plants and rugs. width is the symbol's extent along its local x (before rotation), depth its local y, center the symbol's bounding-box center. Furniture symbols are NEVER walls: report them ONLY in furniture, never in walls. Record a kitchen counter run as ONE kitchen_run entry, plus separate entries for any fridge/sink/hob symbols drawn on it. Do NOT skip bathroom fixtures (toilet, shower, bathtub, washbasin) — they identify the room type.

DO NOT trace as walls: furniture, kitchen counters, wardrobes, stairs, dimension lines, extension lines, hatching, text, door leaves or their swing arcs. If a "wall" is thinner than every other line and touches nothing, it is probably a dimension line.

A rectangle with an X or diagonal cross drawn through it is a FURNITURE OR FIXTURE SYMBOL — a wardrobe, cabinet, appliance or service shaft — never a room. Do not trace any of its four sides as walls, even when it sits flush against real walls; its outline is cabinetry, not structure. The same goes for a staircase bounded by thin railing lines inside a larger room: the railing is not a wall.

Record your analysis with the record_plan_analysis tool. Be exhaustive with walls — a missed wall ruins the 3D model.`

// Second pass: the model reviews its own extraction against the image and
// returns a small diff of corrections — much cheaper/faster than re-emitting
// the full analysis, which matters inside serverless time budgets.
const CORRECTIONS_TOOL = {
  name: 'record_plan_corrections',
  description: 'Record corrections to a previous plan analysis after re-checking it against the image.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'missedWalls', 'falseWallIndexes', 'adjustedWalls', 'missedDoors', 'falseDoorIndexes', 'missedWindows', 'falseWindowIndexes', 'missedRooms', 'scaleCorrection'],
    properties: {
      summary: { type: 'string', description: 'One or two sentences on what was wrong, or "extraction verified" if nothing.' },
      // The correction arrays are required (empty when there's nothing to correct);
      // sharing walls/doors/windows/rooms item schemas with ANALYSIS_TOOL by identity
      // means the additionalProperties/required edits above apply to both tools.
      missedWalls: { type: 'array', description: 'Walls present in the image but absent from the analysis.', items: ANALYSIS_TOOL.input_schema.properties.walls.items },
      falseWallIndexes: { type: 'array', description: '0-based indexes into the analysis walls array of walls that do NOT exist in the image (furniture, dimension lines, double-traced faces).', items: { type: 'number' } },
      adjustedWalls: {
        type: 'array',
        description: 'Walls whose endpoints are significantly wrong (off by more than ~15px).',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'start', 'end'],
          properties: {
            index: { type: 'number' },
            start: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
            end: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
          },
        },
      },
      missedDoors: { type: 'array', items: ANALYSIS_TOOL.input_schema.properties.doors.items },
      falseDoorIndexes: { type: 'array', items: { type: 'number' } },
      missedWindows: { type: 'array', items: ANALYSIS_TOOL.input_schema.properties.windows.items },
      falseWindowIndexes: { type: 'array', items: { type: 'number' } },
      missedRooms: { type: 'array', items: ANALYSIS_TOOL.input_schema.properties.rooms.items },
      // nullable via anyOf: usually there is no scale correction. The shared scale schema is
      // required-non-null at the top level, so we wrap (not mutate) it to allow null here.
      scaleCorrection: { anyOf: [ANALYSIS_TOOL.input_schema.properties.scale, { type: 'null' }] },
    },
  },
}

const REFINE_SYSTEM_PROMPT = `You are re-checking a structured extraction of an architectural plan against the original image. The extraction will drive a walkable 3D model, so errors have physical consequences: a missed wall is a hole, an invented wall blocks a corridor, a missed door seals a room.

Check, in order:
1. FALSE WALLS: walls in the extraction that are actually furniture, counters, stairs, dimension lines, text, door swing arcs — or a second trace of a wall already listed (two parallel segments ~one wall-thickness apart along the same span are one double-traced wall: keep one index, report the other as false). Pay special attention to rectangles with an X/diagonal cross through them: those are wardrobe/cabinet/shaft symbols, and any extracted wall lying on one of their sides is false.
2. MISSED WALLS: real walls absent from the extraction. Compare room by room — every room on the drawing must be fully enclosed by extracted walls (with doors as the only gaps).
3. DOORS: every room must be reachable — each room needs at least one door/doorway in the extraction. Find the openings for any sealed room. Also drop doors that don't exist.
4. ROOMS: any labeled or clearly-drawn room missing from the extraction's room list.
5. SCALE: spot-check one printed dimension against its pixel length; correct the scale if it's off by more than ~10%. Bare numbers like 3670 are millimeters.

Report ONLY genuine discrepancies — do not nudge coordinates that are roughly right. If the extraction is faithful, record an empty correction with summary "extraction verified". Always respond via the record_plan_corrections tool.`

// Strict tool use is newer than the rest of this call path and can't be exercised
// locally without a live key, so guard against it 400ing every upload in production
// (a past regression shipped an untestable param that did exactly that): if the API
// rejects the request with a 400, retry ONCE with strict stripped from every tool.
// Maps the tools array to new objects so the module-level constants stay untouched.
async function createWithStrictFallback(client, params) {
  try {
    return await client.messages.create(params)
  } catch (err) {
    if (err?.status !== 400) throw err
    console.warn(`[planAnalysis] strict tool use rejected (${err?.message}); retrying without strict`)
    const tools = (params.tools || []).map(({ strict, ...rest }) => rest)
    return await client.messages.create({ ...params, tools })
  }
}

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
  const response = await createWithStrictFallback(client, {
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
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
  const response = await createWithStrictFallback(client, {
    model: model || DEFAULT_MODEL,
    max_tokens: 8000,
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
