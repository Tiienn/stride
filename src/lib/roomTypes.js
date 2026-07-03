// Per-room-type configuration: floor finish, footstep surface, light character,
// and which furniture set the placer uses. This is the single mapping between
// "what the plan says a room is" and "how it looks, sounds and is furnished".

export const ROOM_TYPES = {
  living:    { floor: 'woodFloor', surface: 'wood',     lightColor: '#ffd9a0', lightIntensity: 1.0, furniture: 'living' },
  dining:    { floor: 'woodFloor', surface: 'wood',     lightColor: '#ffd9a0', lightIntensity: 1.0, furniture: 'dining' },
  bedroom:   { floor: 'woodFloor', surface: 'wood',     lightColor: '#ffe2b8', lightIntensity: 0.85, furniture: 'bedroom' },
  kitchen:   { floor: 'tiles',     surface: 'tile',     lightColor: '#fff3e0', lightIntensity: 1.1, furniture: 'kitchen' },
  bathroom:  { floor: 'tiles',     surface: 'tile',     lightColor: '#f4f7ff', lightIntensity: 0.9, furniture: 'bathroom' },
  hall:      { floor: 'woodFloor', surface: 'wood',     lightColor: '#ffe2b8', lightIntensity: 0.8, furniture: 'hall' },
  office:    { floor: 'carpet',    surface: 'carpet',   lightColor: '#f2f6ff', lightIntensity: 1.15, furniture: 'office' },
  meeting:   { floor: 'carpet',    surface: 'carpet',   lightColor: '#f2f6ff', lightIntensity: 1.1, furniture: 'meeting' },
  reception: { floor: 'tiles',     surface: 'tile',     lightColor: '#fff0dd', lightIntensity: 1.05, furniture: 'reception' },
  storage:   { floor: 'concrete',  surface: 'concrete', lightColor: '#ffffff', lightIntensity: 0.7, furniture: 'none' },
  garage:    { floor: 'concrete',  surface: 'concrete', lightColor: '#ffffff', lightIntensity: 0.8, furniture: 'none' },
  balcony:   { floor: 'pavingStones', surface: 'concrete', lightColor: '#ffe2b8', lightIntensity: 0.6, furniture: 'balcony' },
  generic:   { floor: 'woodFloor', surface: 'wood',     lightColor: '#ffe2b8', lightIntensity: 0.9, furniture: 'none' },
}

export function roomConfig(type) {
  return ROOM_TYPES[type] || ROOM_TYPES.generic
}

// Infer a room type from a free-text label when the analyzer didn't set one.
const NAME_RULES = [
  [/(master|bed|chambre|dormitor)/i, 'bedroom'],
  [/(living|lounge|salon|family|sitting)/i, 'living'],
  [/(kitchen|cuisine|kitchenette|pantry)/i, 'kitchen'],
  [/(bath|wc|toilet|shower|ensuite|en-suite|powder)/i, 'bathroom'],
  [/(dining|dinner)/i, 'dining'],
  [/(hall|corridor|entry|entrance|foyer|landing|passage)/i, 'hall'],
  [/(meeting|conference|board)/i, 'meeting'],
  [/(reception|lobby|waiting)/i, 'reception'],
  [/(office|bureau|study|work|open.?plan|desk)/i, 'office'],
  [/(store|storage|closet|utility|laundry)/i, 'storage'],
  [/(garage|carport)/i, 'garage'],
  [/(balcon|terrace|patio|deck|veranda)/i, 'balcony'],
]

export function inferRoomType(name, planType) {
  for (const [re, type] of NAME_RULES) if (re.test(name || '')) return type
  return planType === 'office' ? 'office' : 'generic'
}
