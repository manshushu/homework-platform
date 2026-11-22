function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDate(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatLocalDateTime(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  return `${formatLocalDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatTimestampForFilename(input = new Date()) {
  if (typeof input === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/.exec(input.trim());
    if (m) {
      return `${m[1]}${m[2]}${m[3]}_${m[4]}${m[5]}${m[6]}`;
    }
  }
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) {
    return formatTimestampForFilename(new Date());
  }
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function getCurrentIsoWeekString(d = new Date()) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = date.getDay() || 7;
  date.setDate(date.getDate() + 4 - dayNum);
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getFullYear()}-W${pad2(weekNo)}`;
}

function getIsoWeekDateRange(weekStr) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekStr || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;

  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const week1Monday = new Date(year, 0, 4 - (jan4Day - 1));
  const targetMonday = new Date(week1Monday);
  targetMonday.setDate(week1Monday.getDate() + (week - 1) * 7);
  const targetSunday = new Date(targetMonday);
  targetSunday.setDate(targetMonday.getDate() + 6);

  return {
    startDate: formatLocalDate(targetMonday),
    endDate: formatLocalDate(targetSunday)
  };
}

function getWeekRangeForDate(d = new Date()) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = date.getDay() || 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - (dayNum - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    startDate: formatLocalDate(monday),
    endDate: formatLocalDate(sunday)
  };
}

function isValidDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
}

/**
 * Resolve query/body date filter parameters into a concrete local date range.
 * Default scope when omitted is 'all' for backward-compatible API calls unless specified.
 */
function resolveDateRange(params = {}, defaultScope = 'all') {
  const rawScope = String(params.scope || '').trim().toLowerCase();
  const dateParam = String(params.date || '').trim();
  const weekParam = String(params.week || '').trim();
  const startParam = String(params.start_date || params.startDate || '').trim();
  const endParam = String(params.end_date || params.endDate || '').trim();

  if (isValidDateStr(startParam) && isValidDateStr(endParam)) {
    const startDate = startParam <= endParam ? startParam : endParam;
    const endDate = startParam <= endParam ? endParam : startParam;
    return {
      scope: 'custom',
      startDate,
      endDate,
      label: startDate === endDate ? startDate : `${startDate} ~ ${endDate}`,
      fileTag: startDate === endDate ? startDate.replace(/-/g, '') : `${startDate.replace(/-/g, '')}_${endDate.replace(/-/g, '')}`
    };
  }

  const scope = rawScope || (isValidDateStr(dateParam) ? 'date' : (weekParam ? 'week' : defaultScope));

  if (scope === 'today') {
    const today = formatLocalDate(new Date());
    return {
      scope: 'today',
      startDate: today,
      endDate: today,
      label: `今天 (${today})`,
      fileTag: today.replace(/-/g, '')
    };
  }

  if (scope === 'date') {
    const target = isValidDateStr(dateParam) ? dateParam : formatLocalDate(new Date());
    return {
      scope: 'date',
      startDate: target,
      endDate: target,
      label: target,
      fileTag: target.replace(/-/g, '')
    };
  }

  if (scope === 'week') {
    if (weekParam) {
      const weekRange = getIsoWeekDateRange(weekParam);
      if (weekRange) {
        return {
          scope: 'week',
          week: weekParam,
          startDate: weekRange.startDate,
          endDate: weekRange.endDate,
          label: `${weekParam} (${weekRange.startDate} ~ ${weekRange.endDate})`,
          fileTag: weekParam
        };
      }
    }
    const now = new Date();
    const weekStr = getCurrentIsoWeekString(now);
    const range = getWeekRangeForDate(now);
    return {
      scope: 'week',
      week: weekStr,
      startDate: range.startDate,
      endDate: range.endDate,
      label: `本周 (${range.startDate} ~ ${range.endDate})`,
      fileTag: weekStr
    };
  }

  return {
    scope: 'all',
    startDate: null,
    endDate: null,
    label: '全部历史',
    fileTag: '全部历史'
  };
}

module.exports = {
  formatLocalDate,
  formatLocalDateTime,
  formatTimestampForFilename,
  getCurrentIsoWeekString,
  getIsoWeekDateRange,
  getWeekRangeForDate,
  resolveDateRange
};
