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

const SYSTEM_PROMPT = `You are an expert architectural plan analyzer. You extract precise structured data from 2D plan images for 3D reconstruction.

CRITICAL RULES:
1. All coordinates are PIXELS from the image's top-left corner.
2. Walls are defined by their CENTER LINE, not edges.
3. First classify the plan: an interior floor plan (residential or office) vs a site/land plan (parcel boundary, plot). Site plans show property lines, lot dimensions, north arrows, setbacks, roads — not interior walls.
4. For interior plans: trace EVERY wall segment corner to corner. Exterior walls are thicker (15-25px typical) than interior (8-15px). Do not skip short segments. Wall endpoints that meet must share identical coordinates.
5. Doors: quarter-circle arc = hinged door. Gap with no arc = doorway. The building's main entry door has kind "entrance".
6. Windows: short parallel lines / thin rectangles crossing exterior walls.
7. Scale, in priority order: (a) printed dimension labels — bare numbers like 3670 are MILLIMETERS, decimals like 5.37 are METERS; (b) printed total area worked backward; (c) standard door width 0.9m; (d) estimate. Report source and confidence honestly.
8. Room centers must be INSIDE the room, far from any wall — they seed a flood fill.
9. Site plans: trace the parcel boundary polygon precisely, note the road-facing edge if drawn.
Record your analysis with the record_plan_analysis tool. Be exhaustive with walls — a missed wall ruins the 3D model.`

export async function analyzePlanImage(body, { apiKey, model } = {}) {
  if (!apiKey) {
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

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
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
