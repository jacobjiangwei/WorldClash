export const PROMOTIONS = [
  { name: 'Tinyo Music', description: '发现喜欢的音乐', icon: '🎵', url: 'https://apps.apple.com/app/id6790333233' },
  { name: 'BikeX', description: '记录每一次骑行', icon: '🚴', url: 'https://apps.apple.com/app/id6782549805' },
  { name: 'Cinavo', description: 'AI 字幕视频播放器', icon: '🎬', url: 'https://apps.apple.com/app/id6819967033' },
];

export function nextPromotionIndex(length, previous, random = Math.random) {
  if (length <= 1) return 0;
  if (previous < 0 || previous >= length) return Math.floor(random() * length);
  const index = Math.floor(random() * (length - 1));
  return index >= previous ? index + 1 : index;
}

export function startPromotions(element, { delay = 15000, interval = 60000, duration = 8000 } = {}) {
  let previous = -1;
  let hideTimer;
  const show = () => {
    if (document.hidden) return;
    previous = nextPromotionIndex(PROMOTIONS.length, previous);
    const promotion = PROMOTIONS[previous];
    element.href = promotion.url;
    element.querySelector('.promo-icon').textContent = promotion.icon;
    element.querySelector('.promo-name').textContent = promotion.name;
    element.querySelector('.promo-description').textContent = promotion.description;
    element.hidden = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { element.hidden = true; }, duration);
  };
  setTimeout(() => {
    show();
    setInterval(show, interval);
  }, delay);
}
