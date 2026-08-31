const JAPANESE_LANGUAGE = 'ja-JP';

function restoreOfficialWorkNames(localizedName, sourceTag, officialWorkNames) {
  if (typeof localizedName !== 'string' || typeof sourceTag !== 'string') {
    return localizedName;
  }

  const sourceParts = [...sourceTag.matchAll(/\(([^()]*)\)/g)].map(match => (
    match[1].trim().toLowerCase().replace(/\s+/g, ' ')
  ));
  let sourceIndex = 0;

  return localizedName.replace(/[（(]([^（）()]*)[）)]/g, (part, localizedPart) => {
    const sourcePart = sourceParts[sourceIndex++];
    const officialName = sourcePart ? officialWorkNames?.[sourcePart] : null;
    return officialName ? `（${officialName}）` : part;
  });
}

export function getLocalizedCharacterName({
  key = '',
  tag = '',
  language = 'en-US',
  characterNames = {},
} = {}) {
  if (language === 'en-US') {
    return tag || key;
  }

  if (language === JAPANESE_LANGUAGE) {
    const localizedName = characterNames?.[JAPANESE_LANGUAGE]?.[tag];
    return localizedName
      ? restoreOfficialWorkNames(localizedName, tag, characterNames?.officialWorkNames)
      : tag || key;
  }

  return key || tag;
}
