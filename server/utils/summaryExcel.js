const XLSX = require('xlsx');
const { formatLocalDateTime } = require('./dateRange');

/**
 * Build an Excel (.xlsx) buffer summarizing per-student homework submissions
 * for a given class (or all classes) and date range.
 */
function buildStudentSummaryWorkbook({ className = '', dateRange = {}, stats = {}, records = [], submissions = [], historicalSubmissions = [] }) {
  const wb = XLSX.utils.book_new();
  const classLabel = className || '全部班级';
  const rangeLabel = dateRange.label || '全部历史';
  const generatedAt = formatLocalDateTime(new Date());

  const headerRows = [
    ['课堂作业提交汇总表'],
    ['筛选班级', classLabel, '统计时间范围', rangeLabel],
    [
      '生成/打包时间',
      generatedAt,
      '人数与份数统计',
      `应交 ${stats.totalStudents || 0} 人 / 已交 ${stats.submittedStudents || 0} 人 / 未交 ${stats.unsubmittedStudents || 0} 人 / 共 ${stats.totalSubmissions || 0} 份`
    ],
    [],
    ['班级', '学号', '姓名', '提交状态', '提交份数', '提交天数', '最近提交时间', '提交文件明细']
  ];

  const dataRows = records.map((r) => {
    const fileDetails = Array.isArray(r.files) && r.files.length > 0
      ? r.files.map((f) => `${f.original_name} (${f.submitted_at || ''})`).join('；')
      : '-';
    return [
      r.class_name,
      String(r.student_no).padStart(2, '0'),
      r.student_name || '-',
      r.submitted ? '已提交' : '未提交',
      Number(r.submission_count) || 0,
      Number(r.submitted_days) || 0,
      r.latest_submitted_at || '-',
      fileDetails
    ];
  });

  const wsSummary = XLSX.utils.aoa_to_sheet([...headerRows, ...dataRows]);
  wsSummary['!cols'] = [
    { wch: 14 },
    { wch: 8 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
    { wch: 10 },
    { wch: 22 },
    { wch: 52 }
  ];
  XLSX.utils.book_append_sheet(wb, wsSummary, '提交汇总');

  // Second sheet: detailed file list for convenient filtering
  const fileHeaderRows = [
    ['筛选班级', classLabel, '统计时间范围', rangeLabel, '生成时间', generatedAt],
    [],
    ['班级', '学号', '姓名', '原始文件名', '提交时间', '文件大小(KB)']
  ];
  const fileRows = [
    ...submissions.map((s) => [
      s.class_name || '',
      String(s.student_no).padStart(2, '0'),
      s.student_name || '-',
      s.original_name || '',
      s.submitted_at || s.updated_at || '',
      Number(((Number(s.file_size) || 0) / 1024).toFixed(1))
    ]),
    ...historicalSubmissions.map((h) => [
      h.class_name || '',
      String(h.student_no).padStart(2, '0'),
      h.student_name || '-',
      `[历史补录] ${h.lesson_title} (${h.status_text || '已交'})`,
      h.submitted_at || '',
      0
    ])
  ];
  const wsFiles = XLSX.utils.aoa_to_sheet([...fileHeaderRows, ...fileRows]);
  wsFiles['!cols'] = [
    { wch: 14 },
    { wch: 8 },
    { wch: 12 },
    { wch: 36 },
    { wch: 22 },
    { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, wsFiles, '文件明细');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  buildStudentSummaryWorkbook
};
