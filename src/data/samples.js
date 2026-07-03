// Bundled sample plans — the keyless demo mode. Authored directly in meters;
// finalizeInteriorPlan/finalizeSitePlan turn them into full ScenePlans at load.
// The preview SVGs in public/samples are generated from this same data
// (scripts/gen-sample-svgs.mjs) so picture and geometry always match.

import { finalizeInteriorPlan, finalizeSitePlan } from '../lib/planProcess.js'

const EXT = 0.24
const INT = 0.12

const wall = (x1, z1, x2, z2, opts = {}) => ({
  id: `w-${x1}-${z1}-${x2}-${z2}`,
  start: { x: x1, z: z1 },
  end: { x: x2, z: z2 },
  height: 2.7,
  thickness: opts.ext ? EXT : INT,
  isExterior: !!opts.ext,
  openings: (opts.openings || []).map((o, i) => ({
    id: `o-${x1}-${z1}-${i}`,
    type: o.t,
    position: o.p,
    width: o.w,
    height: o.h ?? (o.t === 'window' ? 1.35 : 2.05),
    sillHeight: o.s ?? (o.t === 'window' ? 0.9 : 0),
  })),
})

const room = (name, type, x, z) => ({ id: `r-${name}`, name, type, center: { x, z } })

// --------------------------------------------------------------------------
// Sample 1 — two-bedroom apartment, 11 × 8 m
// --------------------------------------------------------------------------
export const apartmentFixture = () =>
  finalizeInteriorPlan({
    planType: 'floor',
    name: 'Two-Bedroom Apartment',
    walls: [
      // exterior, clockwise from NW corner (north = -z)
      wall(-5.5, -4, 5.5, -4, { ext: true, openings: [
        { t: 'window', p: 2.5, w: 1.6 },              // kitchen
        { t: 'window', p: 5.95, w: 0.6, s: 1.3, h: 0.7 }, // bathroom
        { t: 'window', p: 8.8, w: 1.5 },              // bedroom 1
      ]}),
      wall(5.5, -4, 5.5, 4, { ext: true, openings: [
        { t: 'window', p: 2.3, w: 1.4 },              // bedroom 1
        { t: 'window', p: 6.3, w: 1.4 },              // bedroom 2
      ]}),
      wall(5.5, 4, -5.5, 4, { ext: true, openings: [
        { t: 'window', p: 2.2, w: 1.5 },              // bedroom 2
        { t: 'entrance', p: 5.05, w: 1.05 },          // front door → hall
        { t: 'window', p: 8.5, w: 1.8 },              // living
      ]}),
      wall(-5.5, 4, -5.5, -4, { ext: true, openings: [
        { t: 'window', p: 2.5, w: 2.2 },              // living
        { t: 'window', p: 6.0, w: 1.6 },              // kitchen
      ]}),
      // interior
      wall(-0.3, -4, -0.3, 4, { openings: [
        { t: 'doorway', p: 6.2, w: 1.6 },             // living ↔ hall
      ]}),
      wall(1.2, -4, 1.2, 4, { openings: [
        { t: 'door', p: 3.8, w: 0.9 },                // hall → bedroom 1
        { t: 'door', p: 5.4, w: 0.9 },                // hall → bedroom 2
      ]}),
      wall(1.2, 0.6, 5.5, 0.6),                        // bedroom 1 / bedroom 2
      wall(-0.3, -1, 1.2, -1, { openings: [
        { t: 'door', p: 0.75, w: 0.75 },              // hall → bathroom
      ]}),
      wall(-5.5, -0.5, -0.3, -0.5, { openings: [
        { t: 'doorway', p: 2.6, w: 2.6 },             // kitchen ↔ living, open plan
      ]}),
    ],
    rooms: [
      room('Living Room', 'living', -2.9, 1.75),
      room('Kitchen · Dining', 'kitchen', -2.9, -2.25),
      room('Bathroom', 'bathroom', 0.45, -2.5),
      room('Hall', 'hall', 0.45, 1.6),
      room('Bedroom 1', 'bedroom', 3.35, -1.7),
      room('Bedroom 2', 'bedroom', 3.35, 2.3),
    ],
  })

// --------------------------------------------------------------------------
// Sample 2 — office floor, 16 × 10 m
// --------------------------------------------------------------------------
export const officeFixture = () =>
  finalizeInteriorPlan({
    planType: 'office',
    name: 'Studio Office Floor',
    walls: [
      wall(-8, -5, 8, -5, { ext: true, openings: [
        { t: 'window', p: 2.0, w: 1.8 },   // reception
        { t: 'window', p: 6.5, w: 2.4 },   // open plan
        { t: 'window', p: 10.0, w: 2.4 },  // open plan
        { t: 'window', p: 14.0, w: 1.8 },  // office 1
      ]}),
      wall(8, -5, 8, 5, { ext: true, openings: [
        { t: 'window', p: 1.7, w: 1.6 },   // office 1
        { t: 'window', p: 5.1, w: 1.6 },   // office 2
        { t: 'window', p: 8.4, w: 1.4 },   // kitchenette
      ]}),
      wall(8, 5, -8, 5, { ext: true, openings: [
        { t: 'window', p: 2.0, w: 1.6 },   // kitchenette
        { t: 'window', p: 10.8, w: 0.6, s: 1.3, h: 0.7 }, // wc
        { t: 'window', p: 14.0, w: 2.2 },  // meeting
      ]}),
      wall(-8, 5, -8, -5, { ext: true, openings: [
        { t: 'window', p: 2.5, w: 2.4 },   // meeting
        { t: 'entrance', p: 7.5, w: 1.6 }, // main entrance → reception
      ]}),
      // interior
      wall(-4, -5, -4, 5, { openings: [
        { t: 'doorway', p: 2.5, w: 2.2 },  // reception ↔ open plan
      ]}),
      wall(-8, 0, -4, 0, { openings: [
        { t: 'door', p: 2.0, w: 1.0 },     // reception → meeting
      ]}),
      wall(4, -5, 4, 5, { openings: [
        { t: 'door', p: 1.7, w: 0.9 },     // open plan → office 1
        { t: 'door', p: 5.1, w: 0.9 },     // open plan → office 2
        { t: 'doorway', p: 8.4, w: 1.4 },  // open plan ↔ kitchenette
      ]}),
      wall(4, -1.6, 8, -1.6),               // office 1 / office 2
      wall(4, 1.8, 8, 1.8),                 // office 2 / kitchenette
      wall(-4, 3.4, -1.6, 3.4, { openings: [
        { t: 'door', p: 1.2, w: 0.8 },     // open plan → wc
      ]}),
      wall(-1.6, 3.4, -1.6, 5),             // wc east wall
    ],
    rooms: [
      room('Reception', 'reception', -6, -2.5),
      room('Meeting Room', 'meeting', -6, 2.5),
      room('Open Plan', 'office', 0, -0.5),
      room('Office 1', 'office', 6, -3.3),
      room('Office 2', 'office', 6, 0.1),
      room('Kitchenette', 'kitchen', 6, 3.4),
      room('WC', 'bathroom', -2.8, 4.2),
    ],
  })

// --------------------------------------------------------------------------
// Sample 3 — land parcel, ~1,250 m²
// --------------------------------------------------------------------------
export const siteFixture = () =>
  finalizeSitePlan({
    planType: 'site',
    name: 'Corner Plot · ~1,250 m²',
    site: {
      boundary: [
        { x: -16, z: -21 },
        { x: 14, z: -19 },
        { x: 17, z: 18 },
        { x: -13, z: 22 },
      ],
      areaM2: null, // computed from the polygon
      roadEdge: { start: { x: -13, z: 22 }, end: { x: 17, z: 18 } },
    },
  })

export const SAMPLES = [
  {
    id: 'apartment',
    label: 'Apartment',
    caption: 'Two-bed · 88 m² · residential floor plan',
    image: '/samples/apartment.svg',
    build: apartmentFixture,
  },
  {
    id: 'office',
    label: 'Office floor',
    caption: 'Studio office · 160 m² · workplace plan',
    image: '/samples/office.svg',
    build: officeFixture,
  },
  {
    id: 'site',
    label: 'Land parcel',
    caption: 'Corner plot · ~1,250 m² · site plan',
    image: '/samples/site.svg',
    build: siteFixture,
  },
]
