const palette = { ink: '#312822', yellow: '#FFD35B', red: '#D94232', cream: '#FFF8E8' };
const face = '<ellipse cx="40" cy="43" rx="2.3" ry="3.5" fill="#312822"/><ellipse cx="59" cy="43" rx="2.3" ry="3.5" fill="#312822"/><path d="M44 54q6 6 12-1" fill="none" stroke="#312822" stroke-width="2.8" stroke-linecap="round"/><ellipse cx="33" cy="50" rx="5" ry="2.6" fill="#ED9874" opacity=".8"/><ellipse cx="65" cy="50" rx="5" ry="2.6" fill="#ED9874" opacity=".8"/>';
const art = {
  burger: '<path d="M17 39C19 12 80 12 83 39Z" fill="#EFB256" stroke="#312822" stroke-width="2.2"/><path d="M18 40h64v13H18z" fill="#97AC50"/><path d="M16 49q16 8 33 0t35 1v12H16Z" fill="#844C30"/><path d="M19 61h62v6q0 12-13 12H32Q19 79 19 67Z" fill="#E8A34A" stroke="#312822" stroke-width="2.2"/><path d="m27 30 3-2m14-7 2 3m12-2 3 1m9 6 3 2" stroke="#FFF0C9" stroke-width="3" stroke-linecap="round"/>',
  fries: '<g fill="#FFD35B" stroke="#B5893A" stroke-width="1.5"><path d="m23 50-3-32 10-2 3 36Z"/><path d="M34 51V9h10v44Z"/><path d="m47 52 1-40h10l-1 42Z"/><path d="m60 54 6-37 10 2-6 38Z"/></g><path d="M17 39q33 13 67 0l-7 38q-27 11-53 0Z" fill="#D94232" stroke="#312822" stroke-width="2.2"/>',
  drink: '<path d="m29 19 47-5-9 66H36Z" fill="#CE4636" stroke="#312822" stroke-width="2.2"/><path d="M27 16q27-5 51-2v10H27Z" fill="#FFF3D3" stroke="#312822" stroke-width="2.2"/><path d="m53 16 3-12h15" fill="none" stroke="#312822" stroke-width="4" stroke-linecap="round"/><path d="M37 64h28" stroke="#ED8B73" stroke-width="3"/>',
  chicken: '<path d="M20 45q-4-19 16-23t25 14q22-4 22 16T65 76q-15 9-26-3-19 7-24-8t5-20Z" fill="#DB9850" stroke="#312822" stroke-width="2.2"/><g fill="#BE7C38"><circle cx="29" cy="39" r="2"/><circle cx="65" cy="61" r="2"/><circle cx="34" cy="68" r="2"/><circle cx="71" cy="47" r="2"/><circle cx="50" cy="29" r="2"/></g>',
  dessert: '<path d="m27 47 46-1-22 38Z" fill="#D6A664" stroke="#312822" stroke-width="2.2"/><path d="m34 53 24 20m8-20L43 72" stroke="#B98045" stroke-width="2"/><path d="M24 44q-2-12 11-15-3-10 8-14-1-9 9-10 9 8 9 17 12 5 9 15 11 2 7 12Z" fill="#FFF4D4" stroke="#312822" stroke-width="2.2"/>',
  other: '<path d="M19 29q30-12 62 0v39q-31 15-62 0Z" fill="#FFD35B" stroke="#312822" stroke-width="2.2"/><path d="M19 29q31 14 62 0M50 36v41" fill="none" stroke="#B5893A" stroke-width="2.2"/>'
};
export const kinds = Object.freeze(Object.keys(art));
export function avatarSvg(kind = 'other') {
  const food = Object.hasOwn(art, kind) ? art[kind] : art.other;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47" fill="${palette.cream}"/>${food}${face}<path d="m13 55-5 5m78-7 6 4" stroke="#312822" stroke-width="2.5" stroke-linecap="round"/></svg>`;
}
const images = new Map();
export async function drawAvatar(ctx, kind, x, y, size) {
  const safeKind = kinds.includes(kind) ? kind : 'other';
  if (!images.has(safeKind)) {
    images.set(safeKind, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(safeKind))}`;
    }));
  }
  const img = await images.get(safeKind);
  ctx.drawImage(img, x, y, size, size);
}
