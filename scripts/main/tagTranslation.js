export function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

export function parseTranslationLine(line) {
    const parts = parseCsvFields(String(line));
    if (parts.length < 2) return null;

    const prompt = parts[0].trim();
    const hasGroupColumn = parts.length >= 3 && /^\d+$/.test(parts[1].trim());
    const group = hasGroupColumn ? Number.parseInt(parts[1], 10) : 0;
    const aliases = (hasGroupColumn ? parts.slice(2).join(',') : parts.slice(1).join(',')).trim();

    return { prompt, group, aliases };
}

function parseCsvFields(line) {
    const fields = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === ',' && !quoted) {
            fields.push(field);
            field = '';
        } else {
            field += character;
        }
    }
    if (quoted) return [];
    fields.push(field);
    return fields;
}
