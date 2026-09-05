/**
 * Minimal markdown → plain text (no WYSIWYG): shared by the PDF export
 * (artifact bodies) and the deterministic image-prompt builder, which feeds
 * the image API prose instead of markdown syntax.
 */
export function markdownToText(markdown: string): string {
  return markdown
    .replaceAll(/```[\s\S]*?```/g, (block) => block.replaceAll(/^```[a-z]*\n?|```$/gm, ''))
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replaceAll(/^#{1,6}\s+/gm, '')
    .replaceAll(/\*\*([^*]+)\*\*/g, '$1')
    .replaceAll(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '$1')
    .replaceAll(/(?<!_)_([^_\n]+)_(?!_)/g, '$1')
    .replaceAll(/`([^`]+)`/g, '$1')
    .trim();
}
