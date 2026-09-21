const JAPANESE_LANGUAGE = 'ja-JP';

function restoreOfficialWorkNames(localizedName, sourceTag, officialWorkNames) {
  if (typeof localizedName !== 'string' || typeof sourceTag !== 'string') {
    return localizedName;
  }

  const sourceParts = [...sourceTag.matchAll(/\(([^()]*)\)/g)].map(match => (
    match[1].trim().toLowerCase().replace(/\s+/g, ' ')
  ));
  // The qualifiers are aligned from the end: the work is the last one on both
  // sides, while a reviewed name may carry an extra qualifier of its own
  // (大潮（改二）（艦隊これくしょん） for ooshio_kai_ni_(kancolle)).
  const localizedParts = [...localizedName.matchAll(/[（(][^（）()]*[）)]/g)];
  const offset = localizedParts.length - sourceParts.length;
  let localizedIndex = 0;

  return localizedName.replace(/[（(]([^（）()]*)[）)]/g, (part) => {
    const sourcePart = sourceParts[localizedIndex++ - offset];
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
