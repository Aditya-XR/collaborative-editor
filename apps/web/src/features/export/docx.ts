import type { JSONContent } from '@tiptap/core'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx'

/** Images are fetched by address; one that cannot be (offline, no CORS) becomes its link. */
export type FetchImage = (src: string) => Promise<FetchedImage | null>
type ImageType = 'jpg' | 'png' | 'gif' | 'bmp'
interface FetchedImage {
  data: ArrayBuffer
  type: ImageType
  width: number
  height: number
}

/** The widest an image may be on an A4 page with 2.5 cm margins, in pixels at 96 dpi. */
const MAX_IMAGE_WIDTH = 600
const INDENT_PER_LEVEL = 720 // twips: half an inch
const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

interface Style {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  underline?: boolean
  code?: boolean
}

interface Context {
  /** How many lists enclose this block: its indent, and the level of a list inside it. */
  depth: number
  /** Inside a quote: indented, with a rule on the left. */
  quote: boolean
}

const TOP: Context = { depth: 0, quote: false }

/**
 * Builds a Word document from the editor's JSON, in the browser, so it works offline too
 * (ADR 0020). Each node type maps to the closest Word construct: headings to heading styles,
 * lists to real Word lists that renumber when edited, checklists to ☐/☒, tables to tables.
 */
export async function toDocx(
  doc: JSONContent,
  title: string,
  fetchImage: FetchImage = fetchImageFromWeb,
): Promise<Blob> {
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = []

  /** Each numbered list counts from its own start. */
  const newOrderedList = (start: number): string => {
    const reference = `ordered-${numbering.length + 1}`
    const levels: ILevelsOptions[] = Array.from({ length: 9 }, (_, level) => ({
      level,
      format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3]!,
      text: `%${level + 1}.`,
      start: level === 0 ? start : 1,
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: INDENT_PER_LEVEL * (level + 1), hanging: 360 } } },
    }))
    numbering.push({ reference, levels })
    return reference
  }

  async function blocks(nodes: JSONContent[], context: Context): Promise<(Paragraph | Table)[]> {
    const out: (Paragraph | Table)[] = []
    for (const node of nodes) out.push(...(await block(node, context)))
    return out
  }

  /** A paragraph placed for its context: under a list item, or in a quote. */
  function paragraph(children: ParagraphChild[], context: Context, extra: IParagraphOptions = {}) {
    const indent = context.depth + (context.quote ? 1 : 0)
    return new Paragraph({
      children,
      ...(indent > 0 ? { indent: { left: INDENT_PER_LEVEL * indent } } : {}),
      ...(context.quote
        ? { border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CBD5E1', space: 12 } } }
        : {}),
      ...extra,
    })
  }

  async function block(node: JSONContent, context: Context): Promise<(Paragraph | Table)[]> {
    switch (node.type) {
      case 'paragraph':
        return [paragraph(await inline(node.content ?? [], {}), context)]
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6)
        return [
          paragraph(await inline(node.content ?? [], {}), context, {
            heading: HEADINGS[level - 1],
          }),
        ]
      }
      case 'blockquote':
        return blocks(node.content ?? [], { ...context, quote: true })
      case 'codeBlock':
        return codeLines(node).map((line) =>
          paragraph([new TextRun({ text: line, font: 'Consolas', size: 20 })], context, {
            shading: { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' },
            spacing: { before: 0, after: 0 },
          }),
        )
      case 'horizontalRule':
        return [
          paragraph([], context, {
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CBD5E1', space: 1 } },
          }),
        ]
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return list(node, context)
      case 'image':
        return [paragraph([await image(node)], context)]
      case 'table':
        return [await table(node)]
      default:
        return [paragraph(await inline(node.content ?? [], {}), context)]
    }
  }

  /** Each item's first paragraph carries the marker; the rest of the item sits indented under it. */
  async function list(node: JSONContent, context: Context): Promise<(Paragraph | Table)[]> {
    const level = Math.min(context.depth, 8)
    const reference =
      node.type === 'orderedList' ? newOrderedList(Number(node.attrs?.start ?? 1)) : null
    const inside: Context = { ...context, depth: context.depth + 1 }
    const out: (Paragraph | Table)[] = []
    for (const item of node.content ?? []) {
      for (const [index, child] of (item.content ?? []).entries()) {
        if (index > 0 || child.type !== 'paragraph') {
          out.push(...(await block(child, inside)))
          continue
        }
        const text = await inline(child.content ?? [], {})
        if (node.type === 'taskList') {
          const box = new TextRun(item.attrs?.checked ? '☒ ' : '☐ ')
          out.push(
            paragraph([box, ...text], inside, {
              indent: { left: INDENT_PER_LEVEL * (level + 1), hanging: 360 },
            }),
          )
        } else {
          // The list level sets the indent; only a quote around the list adds to it.
          const marked = reference ? { numbering: { reference, level } } : { bullet: { level } }
          out.push(paragraph(text, { ...context, depth: 0 }, marked))
        }
      }
    }
    return out
  }

  async function inline(nodes: JSONContent[], base: Style): Promise<ParagraphChild[]> {
    const out: ParagraphChild[] = []
    for (const node of nodes) {
      if (node.type === 'hardBreak') {
        out.push(new TextRun({ text: '', break: 1 }))
        continue
      }
      if (node.type === 'image') {
        out.push(await image(node))
        continue
      }
      if (node.type !== 'text' || !node.text) continue
      const style: Style = { ...base }
      let href: string | null = null
      for (const mark of node.marks ?? []) {
        if (mark.type === 'bold') style.bold = true
        else if (mark.type === 'italic') style.italics = true
        else if (mark.type === 'strike') style.strike = true
        else if (mark.type === 'underline') style.underline = true
        else if (mark.type === 'code') style.code = true
        else if (mark.type === 'link' && typeof mark.attrs?.href === 'string')
          href = mark.attrs.href
      }
      const run = textRun(node.text, style, href !== null)
      out.push(href ? new ExternalHyperlink({ link: href, children: [run] }) : run)
    }
    return out
  }

  async function image(node: JSONContent): Promise<ParagraphChild> {
    const src = String(node.attrs?.src ?? '')
    const alt = String(node.attrs?.alt ?? '')
    const fetched = src ? await fetchImage(src).catch(() => null) : null
    if (!fetched) {
      return new ExternalHyperlink({
        link: src,
        children: [textRun(`[Image${alt ? `: ${alt}` : ''}] ${src}`, {}, true)],
      })
    }
    const scale = Math.min(1, MAX_IMAGE_WIDTH / fetched.width)
    return new ImageRun({
      type: fetched.type,
      data: fetched.data,
      transformation: {
        width: Math.round(fetched.width * scale),
        height: Math.round(fetched.height * scale),
      },
      altText: alt ? { name: alt, description: alt, title: alt } : undefined,
    })
  }

  async function table(node: JSONContent): Promise<Table> {
    const rows: TableRow[] = []
    for (const [index, row] of (node.content ?? []).entries()) {
      const cells: TableCell[] = []
      let header = false
      for (const cell of row.content ?? []) {
        header ||= cell.type === 'tableHeader'
        const content = await blocks(cell.content ?? [], TOP)
        cells.push(
          new TableCell({
            children: content.length > 0 ? content : [new Paragraph('')],
            columnSpan: Number(cell.attrs?.colspan ?? 1),
            rowSpan: Number(cell.attrs?.rowspan ?? 1),
            ...(cell.type === 'tableHeader'
              ? { shading: { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' } }
              : {}),
          }),
        )
      }
      rows.push(new TableRow({ children: cells, tableHeader: header && index === 0 }))
    }
    return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
  }

  const children = await blocks(doc.content ?? [], TOP)
  const document = new Document({
    title,
    creator: 'CollabEdit',
    numbering: { config: numbering },
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      characterStyles: [
        {
          id: 'Hyperlink',
          name: 'Hyperlink',
          run: { color: '4F46E5', underline: {} },
        },
      ],
    },
    sections: [{ children: children.length > 0 ? children : [new Paragraph('')] }],
  })
  return Packer.toBlob(document)
}

function textRun(text: string, style: Style, link: boolean): TextRun {
  return new TextRun({
    text,
    bold: style.bold,
    italics: style.italics,
    strike: style.strike,
    underline: style.underline ? {} : undefined,
    ...(style.code
      ? {
          font: 'Consolas',
          shading: { type: ShadingType.CLEAR, fill: 'F1F5F9', color: 'auto' },
        }
      : {}),
    ...(link ? { style: 'Hyperlink' } : {}),
  })
}

function codeLines(node: JSONContent): string[] {
  const text = (node.content ?? []).map((child) => child.text ?? '').join('')
  return text.split('\n')
}

const TYPES: Record<string, ImageType> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}

/** Downloads an image and measures it. Null when it cannot be had or Word cannot show it. */
async function fetchImageFromWeb(src: string): Promise<FetchedImage | null> {
  const response = await fetch(src, { mode: 'cors', credentials: 'omit' })
  if (!response.ok) return null
  const blob = await response.blob()
  const type = TYPES[blob.type]
  if (!type) return null // WebP, SVG and the like: Word needs its own formats
  const bitmap = await createImageBitmap(blob)
  const size = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return { data: await blob.arrayBuffer(), type, ...size }
}
