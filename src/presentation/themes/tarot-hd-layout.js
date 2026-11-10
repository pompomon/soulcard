import { CARD_IDS } from '../../domain/cards.js'
import { TAROT_LOGICAL_SIZE, TAROT_MAX_TEXTURE_SCALE } from './tarot-composition.js'

// The prerendered Tarot pack: one image per card face and the back at the Tarot
// texture cap, and a preview atlas of half-logical-size cells in CARD_IDS order
// with the back last.
export const TAROT_HD_IMAGE_SIZE = Object.freeze({
  width: TAROT_LOGICAL_SIZE.width * TAROT_MAX_TEXTURE_SCALE,
  height: TAROT_LOGICAL_SIZE.height * TAROT_MAX_TEXTURE_SCALE,
})
export const TAROT_HD_BACK_ID = 'back'
export const TAROT_HD_PREVIEW_ID = 'preview'
export const TAROT_HD_PREVIEW_ORDER = Object.freeze([...CARD_IDS, TAROT_HD_BACK_ID])
export const TAROT_HD_ASSET_IDS = Object.freeze([
  ...TAROT_HD_PREVIEW_ORDER,
  TAROT_HD_PREVIEW_ID,
])

const PREVIEW_COLUMNS = 8
const PREVIEW_CELL_WIDTH = TAROT_LOGICAL_SIZE.width / 2
const PREVIEW_CELL_HEIGHT = TAROT_LOGICAL_SIZE.height / 2
const PREVIEW_ROWS = Math.ceil(TAROT_HD_PREVIEW_ORDER.length / PREVIEW_COLUMNS)

export const TAROT_HD_PREVIEW_LAYOUT = Object.freeze({
  columns: PREVIEW_COLUMNS,
  rows: PREVIEW_ROWS,
  cellWidth: PREVIEW_CELL_WIDTH,
  cellHeight: PREVIEW_CELL_HEIGHT,
  width: PREVIEW_COLUMNS * PREVIEW_CELL_WIDTH,
  height: PREVIEW_ROWS * PREVIEW_CELL_HEIGHT,
})

const PREVIEW_CELLS = new Map(TAROT_HD_PREVIEW_ORDER.map((id, index) => [
  id,
  Object.freeze({
    x: (index % PREVIEW_COLUMNS) * PREVIEW_CELL_WIDTH,
    y: Math.floor(index / PREVIEW_COLUMNS) * PREVIEW_CELL_HEIGHT,
    width: PREVIEW_CELL_WIDTH,
    height: PREVIEW_CELL_HEIGHT,
  }),
]))

export function getTarotHdPreviewCell(id) {
  const cell = PREVIEW_CELLS.get(id)
  if (!cell) {
    throw new RangeError(`Unknown Tarot HD preview cell: ${String(id)}`)
  }
  return cell
}
