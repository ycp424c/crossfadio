/**
 * 用户的滚动行为偏好：系统开启「减弱动态效果」时返回 'auto'，
 * 否则返回 'smooth'。CSS 的 prefers-reduced-motion 媒体查询覆盖不到
 * 通过 JS 显式传入 behavior: 'smooth' 的滚动，需要在这里统一收口。
 */
export function getUserScrollBehavior(): ScrollBehavior {
  if (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return 'auto';
  }
  return 'smooth';
}
