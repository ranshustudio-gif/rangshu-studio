window.rangshuImageUrl = function (url, width, quality) {
  const marker = '/storage/v1/object/public/site-assets/';
  if (!url || !url.includes(marker)) return url;
  const transformed = url.replace(marker, '/storage/v1/render/image/public/site-assets/');
  const separator = transformed.includes('?') ? '&' : '?';
  return transformed + `${separator}width=${width}&format=webp&quality=${quality}`;
};
