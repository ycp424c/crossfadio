const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

export type ShanghaiTimeParts = {
  weekday: string;
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
};

export function getShanghaiTimeParts(date: Date): ShanghaiTimeParts {
  const values = Object.fromEntries(
    shanghaiFormatter.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    weekday: (values.weekday ?? '').replace(/^周/, ''),
    year: values.year ?? '1970',
    month: values.month ?? '01',
    day: values.day ?? '01',
    hour: normalizeHour(Number.parseInt(values.hour ?? '0', 10)),
    minute: Number.parseInt(values.minute ?? '0', 10)
  };
}

export function formatShanghaiLocalTime(date: Date): string {
  const parts = getShanghaiTimeParts(date);
  return `周${parts.weekday} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function formatShanghaiDate(date: Date): string {
  const parts = getShanghaiTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function getShanghaiDaypart(date: Date): string {
  return getDaypart(getShanghaiTimeParts(date).hour);
}

export function getDaypart(hour: number): string {
  if (hour >= 5 && hour < 9) return '早晨';
  if (hour >= 9 && hour < 12) return '上午';
  if (hour >= 12 && hour < 14) return '中午';
  if (hour >= 14 && hour < 17) return '下午';
  if (hour >= 17 && hour < 19) return '傍晚';
  if (hour >= 19 && hour < 23) return '晚上';
  return '深夜';
}

function normalizeHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return hour === 24 ? 0 : hour;
}
