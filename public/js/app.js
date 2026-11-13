// Utility: Escape HTML to prevent XSS
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Utility: Format file size
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Utility: Format date
function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace('T', ' ').slice(0, 19);
}

// Global state
let classList = [];
let latestBroadcastData = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  localStorage.removeItem('last_student_name');
  initServerInfo();
  loadMaterials();
  loadClasses();
  initFormEvents();
  renderLocalHistory();
  loadBroadcastState();
  setInterval(loadBroadcastState, 3000);
});

// 1. Fetch server info (IP and port)
async function initServerInfo() {
  try {
    const res = await fetch('/api/info');
    const json = await res.json();
    if (json.success && json.data) {
      const serverUrlEl = document.getElementById('serverUrl');
      if (serverUrlEl) {
        serverUrlEl.textContent = json.data.primaryUrl;
      }
    }
  } catch (err) {
    console.error('获取服务信息失败:', err);
  }
}

// 2. Fetch and render materials list
async function loadMaterials() {
  const container = document.getElementById('materialsList');
  if (!container) return;

  try {
    const res = await fetch('/api/materials');
    const json = await res.json();

    if (!json.success || !json.data || json.data.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📂</div>
          <p>老师尚未发布课堂资料或作业要求</p>
          <div style="font-size: 12px; margin-top: 4px; color: var(--text-muted);">
            老师在教师端上传文件后，此处将自动显示下载入口
          </div>
        </div>
      `;
      return;
    }

    let html = '';
    for (const item of json.data) {
      const ext = item.original_name.split('.').pop().toLowerCase();
      let icon = '📄';
      if (['sb3', 'sb2'].includes(ext)) icon = '🐱';
      else if (['py', 'ipynb'].includes(ext)) icon = '🐍';
      else if (['mp'].includes(ext)) icon = '💡';
      else if (['zip', 'rar', '7z'].includes(ext)) icon = '📦';
      else if (['doc', 'docx'].includes(ext)) icon = '📝';
      else if (['ppt', 'pptx'].includes(ext)) icon = '📊';
      else if (['jpg', 'png', 'jpeg'].includes(ext)) icon = '🖼️';

      const displayTitle = escapeHtml(item.title || item.original_name);
      html += `
        <div class="material-item">
          <div class="material-info">
            <span class="material-icon">${icon}</span>
            <div class="material-details">
              <div class="material-name" title="${displayTitle}">
                ${displayTitle}
              </div>
              <div class="material-meta">
                <span>大小: ${formatBytes(item.file_size)}</span>
                <span style="margin: 0 6px;">•</span>
                <span>发布: ${formatDate(item.created_at)}</span>
              </div>
            </div>
          </div>
          <a href="/api/materials/download/${item.id}" class="btn btn-outline btn-sm" download>
            ⬇️ 下载
          </a>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state" style="color: var(--danger);">
        <p>加载资料失败，请检查网络连接</p>
      </div>
    `;
  }
}

// 3. Fetch and populate classes with grade optgroups
async function loadClasses() {
  const classSelect = document.getElementById('classSelect');
  if (!classSelect) return;

  try {
    const res = await fetch('/api/classes');
    const json = await res.json();
    if (json.success && json.data) {
      classList = json.data;
      classSelect.innerHTML = '<option value="">-- 请选择班级 --</option>';

      const gradeGroups = {
        '六年级': [],
        '七年级': [],
        '八年级': [],
        '其他班级': []
      };

      classList.forEach(cls => {
        if (cls.name.startsWith('六年级')) {
          gradeGroups['六年级'].push(cls);
        } else if (cls.name.startsWith('七年级')) {
          gradeGroups['七年级'].push(cls);
        } else if (cls.name.startsWith('八年级')) {
          gradeGroups['八年级'].push(cls);
        } else {
          gradeGroups['其他班级'].push(cls);
        }
      });

      for (const [grade, items] of Object.entries(gradeGroups)) {
        if (items.length > 0) {
          const groupEl = document.createElement('optgroup');
          groupEl.label = `--- ${grade} (${items.length}个班) ---`;
          items.forEach(cls => {
            const opt = document.createElement('option');
            opt.value = cls.name;
            opt.dataset.max = cls.max_student_no || 45;
            opt.textContent = `${cls.name} (${cls.roster_count || cls.max_student_no || 45}人)`;
            groupEl.appendChild(opt);
          });
          classSelect.appendChild(groupEl);
        }
      }

      // Restore saved class from localStorage if available
      const savedClass = localStorage.getItem('last_class_name');
      if (savedClass && classList.some(c => c.name === savedClass)) {
        classSelect.value = savedClass;
        await updateStudentNoOptions(savedClass);
      }
    }
  } catch (err) {
    console.error('加载班级失败:', err);
  }
}

// Update student number options based on selected class (strictly numbers only)
async function updateStudentNoOptions(className) {
  const studentNoSelect = document.getElementById('studentNoSelect');
  if (!studentNoSelect) return;

  if (!className) {
    studentNoSelect.innerHTML = '<option value="">-- 请先选择班级 --</option>';
    checkMySubmissionStatus();
    renderBroadcastBanner();
    return;
  }

  let nos = [];
  try {
    const res = await fetch(`/api/classes/student-nos?class_name=${encodeURIComponent(className)}`);
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      nos = json.data;
    }
  } catch (err) {
    console.error('获取学号列表失败:', err);
  }

  if (nos.length === 0) {
    const cls = classList.find(c => c.name === className);
    const maxNo = cls ? (cls.max_student_no || 45) : 45;
    for (let i = 1; i <= maxNo; i++) nos.push(i);
  }

  studentNoSelect.innerHTML = '<option value="">-- 请选择学号 --</option>';
  for (const no of nos) {
    const padded = String(no).padStart(2, '0');
    const opt = document.createElement('option');
    opt.value = no;
    opt.textContent = `${padded} 号`;
    studentNoSelect.appendChild(opt);
  }

  const savedStudentNo = localStorage.getItem('last_student_no');
  if (savedStudentNo && nos.includes(parseInt(savedStudentNo, 10))) {
    studentNoSelect.value = savedStudentNo;
  }

  checkMySubmissionStatus();
  renderBroadcastBanner();
}

// Check single student's own submission status (no names)
async function checkMySubmissionStatus() {
  const className = document.getElementById('classSelect')?.value || '';
  const studentNo = document.getElementById('studentNoSelect')?.value || '';
  const statusBox = document.getElementById('myStatusBox');
  if (!statusBox) return;

  if (!className || !studentNo) {
    statusBox.style.display = 'none';
    statusBox.innerHTML = '';
    return;
  }

  try {
    const res = await fetch(`/api/submission-status?class_name=${encodeURIComponent(className)}&student_no=${encodeURIComponent(studentNo)}`);
    const json = await res.json();
    if (!json.success || !json.data) return;

    const data = json.data;
    const padded = String(studentNo).padStart(2, '0');
    statusBox.style.display = 'flex';

    if (data.submitted) {
      statusBox.className = 'personal-status-box status-submitted';
      statusBox.innerHTML = `
        <div>
          <strong>✅ ${escapeHtml(className)} ${padded}号 已交成功</strong>
          <div style="font-size: 12px; margin-top: 2px;">
            已交文件：${escapeHtml(data.originalName)}（${formatBytes(data.fileSize)}） · 时间：${escapeHtml(formatDate(data.updatedAt))}
          </div>
        </div>
        <span class="badge badge-green">重新提交可覆盖</span>
      `;
    } else {
      statusBox.className = 'personal-status-box status-unsubmitted';
      statusBox.innerHTML = `
        <div>
          <strong>⏳ ${escapeHtml(className)} ${padded}号 尚未提交作业</strong>
          <div style="font-size: 12px; margin-top: 2px;">请在下方选择作业文件并点击“确认提交作业”</div>
        </div>
        <span class="badge" style="background:#fef3c7; color:#b45309;">待提交</span>
      `;
    }
  } catch (err) {
    console.error('查询提交状态失败:', err);
  }
}

// Broadcast polling & rendering (strictly student numbers only, zero names)
async function loadBroadcastState() {
  try {
    const res = await fetch('/api/broadcast');
    const json = await res.json();
    if (json.success) {
      latestBroadcastData = json.data;
      renderBroadcastBanner();
    }
  } catch (err) {
    // Silent retry on next interval
  }
}

function renderBroadcastBanner() {
  const panel = document.getElementById('broadcastPanel');
  const titleEl = document.getElementById('broadcastTitle');
  const statsEl = document.getElementById('broadcastStats');
  const missingRowEl = document.getElementById('broadcastMissingRow');
  const seatGridEl = document.getElementById('broadcastSeatGrid');
  if (!panel) return;

  const data = latestBroadcastData;
  if (!data || !data.active) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  const myClass = document.getElementById('classSelect')?.value || '';
  const myNo = parseInt(document.getElementById('studentNoSelect')?.value || '0', 10);
  const isSameClass = myClass && myClass === data.className;

  titleEl.textContent = `📢 教师正在广播：【${data.className}】未交作业情况`;
  statsEl.innerHTML = `
    <span class="badge badge-green">已交 ${data.submittedCount} / ${data.totalCount} 人</span>
    <span class="badge" style="background:#fee2e2; color:#991b1b;">未交 ${data.missingCount} 人</span>
  `;

  if (data.missingNos.length === 0) {
    missingRowEl.style.background = '#f0fdf4';
    missingRowEl.style.borderColor = '#bbf7d0';
    missingRowEl.innerHTML = `<span style="color:#166534; font-weight:700;">🎉 【${escapeHtml(data.className)}】全员已交齐！</span>`;
  } else {
    missingRowEl.style.background = '#fef2f2';
    missingRowEl.style.borderColor = '#fecaca';
    let tagsHtml = `<span class="missing-tags-label">未交学号 (${data.missingNos.length}人)：</span>`;
    for (const no of data.missingNos) {
      const padded = String(no).padStart(2, '0');
      const isMine = isSameClass && myNo === no;
      tagsHtml += `<span class="missing-tag ${isMine ? 'is-mine' : ''}">${padded}号${isMine ? ' (你)' : ''}</span>`;
    }
    missingRowEl.innerHTML = tagsHtml;
  }

  const submittedSet = new Set(data.submittedNos || []);
  let gridHtml = '';
  for (const no of (data.allNos || [])) {
    const padded = String(no).padStart(2, '0');
    const isSubmitted = submittedSet.has(no);
    const isMine = isSameClass && myNo === no;
    const statusCls = isSubmitted ? 'seat-submitted' : 'seat-missing';
    const mineCls = isMine ? 'seat-mine' : '';
    const titleTip = `${padded}号：${isSubmitted ? '已交成功' : '尚未提交'}${isMine ? '（当前所选学号）' : ''}`;
    gridHtml += `<div class="seat-chip ${statusCls} ${mineCls}" title="${titleTip}">${isSubmitted ? '✓ ' : ''}${padded}${isMine ? '·我' : ''}</div>`;
  }
  seatGridEl.innerHTML = gridHtml;
}

// 4. Form and dropzone events
function initFormEvents() {
  const classSelect = document.getElementById('classSelect');
  const studentNoSelect = document.getElementById('studentNoSelect');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileName = document.getElementById('fileName');
  const fileSize = document.getElementById('fileSize');
  const form = document.getElementById('submissionForm');
  const btnRefreshMaterials = document.getElementById('btnRefreshMaterials');

  // Class selection change
  if (classSelect) {
    classSelect.addEventListener('change', (e) => {
      const cls = e.target.value;
      updateStudentNoOptions(cls);
      if (cls) localStorage.setItem('last_class_name', cls);
    });
  }

  // Student no change
  if (studentNoSelect) {
    studentNoSelect.addEventListener('change', (e) => {
      if (e.target.value) {
        localStorage.setItem('last_student_no', e.target.value);
      }
      checkMySubmissionStatus();
      renderBroadcastBanner();
    });
  }

  // Refresh materials button
  if (btnRefreshMaterials) {
    btnRefreshMaterials.addEventListener('click', () => {
      loadMaterials();
    });
  }

  // File selection change
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        fileName.textContent = file.name;
        fileSize.textContent = `(${formatBytes(file.size)})`;
        fileInfo.style.display = 'inline-flex';
      } else {
        fileInfo.style.display = 'none';
      }
    });
  }

  // Drag and drop handlers
  if (dropzone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
      }, false);
    });

    dropzone.addEventListener('drop', (e) => {
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        const file = fileInput.files[0];
        fileName.textContent = file.name;
        fileSize.textContent = `(${formatBytes(file.size)})`;
        fileInfo.style.display = 'inline-flex';
      }
    });
  }

  // Form submit handler
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const className = classSelect.value;
      const studentNo = studentNoSelect.value;
      const note = (document.getElementById('note').value || '').trim();
      const file = fileInput.files[0];

      if (!className) {
        showNotice('error', '请先选择你所在的班级');
        return;
      }
      if (!studentNo) {
        showNotice('error', '请选择你的学号');
        return;
      }
      if (!file) {
        showNotice('error', '请选择要提交的作业文件');
        return;
      }

      localStorage.setItem('last_class_name', className);
      localStorage.setItem('last_student_no', studentNo);

      const formData = new FormData();
      formData.append('class_name', className);
      formData.append('student_no', studentNo);
      formData.append('note', note);
      formData.append('file', file);

      const btnSubmit = document.getElementById('btnSubmit');
      const btnSubmitText = document.getElementById('btnSubmitText');
      btnSubmit.disabled = true;
      btnSubmitText.textContent = '⏳ 正在上传作业中，请稍候...';

      try {
        const res = await fetch('/api/submissions', {
          method: 'POST',
          body: formData
        });
        const result = await res.json();

        if (result.success) {
          const padded = String(studentNo).padStart(2, '0');
          const msg = `✅ ${escapeHtml(result.message)}（班级: ${escapeHtml(className)}，学号: ${padded}号，文件: ${escapeHtml(file.name)}）`;
          showNotice('success', msg);

          saveLocalHistory({
            className,
            studentNo: padded,
            fileName: file.name,
            fileSize: formatBytes(file.size),
            time: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });

          fileInput.value = '';
          fileInfo.style.display = 'none';
          document.getElementById('note').value = '';

          // Immediately refresh personal status and live broadcast wall
          checkMySubmissionStatus();
          loadBroadcastState();
        } else {
          showNotice('error', escapeHtml(result.message || '提交失败，请重试'));
        }
      } catch (err) {
        showNotice('error', '网络异常或服务未响应，请检查局域网连接');
      } finally {
        btnSubmit.disabled = false;
        btnSubmitText.textContent = '🚀 确认提交作业';
      }
    });
  }
}

// Notice banner
function showNotice(type, message) {
  const notice = document.getElementById('submitNotice');
  if (!notice) return;
  notice.className = `notice notice-${type}`;
  notice.innerHTML = message;
  notice.style.display = 'flex';
  notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Local history storage (strictly no student names)
function saveLocalHistory(item) {
  let list = [];
  try {
    const raw = localStorage.getItem('homework_local_history');
    if (raw) list = JSON.parse(raw);
  } catch (e) {}

  list.unshift({
    className: item.className,
    studentNo: item.studentNo,
    fileName: item.fileName,
    fileSize: item.fileSize,
    time: item.time
  });
  if (list.length > 10) list = list.slice(0, 10);

  try {
    localStorage.setItem('homework_local_history', JSON.stringify(list));
  } catch (e) {}

  renderLocalHistory();
}

function renderLocalHistory() {
  const container = document.getElementById('localHistoryList');
  if (!container) return;

  let list = [];
  try {
    const raw = localStorage.getItem('homework_local_history');
    if (raw) list = JSON.parse(raw);
  } catch (e) {}

  if (!list || list.length === 0) {
    container.innerHTML = '<span style="color: var(--text-muted);">暂无本机提交记录。</span>';
    return;
  }

  let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
  list.forEach(item => {
    html += `
      <div style="background: #ffffff; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
        <div>
          <span class="badge badge-blue">${escapeHtml(item.className)}</span>
          <span style="font-weight: 600; margin-left: 6px;">${escapeHtml(item.studentNo)}号</span>
          <span style="margin-left: 8px; color: var(--text-main);">${escapeHtml(item.fileName)}</span>
          <span style="color: var(--text-muted); font-size: 11px; margin-left: 4px;">${escapeHtml(item.fileSize)}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 12px; color: var(--text-muted);">${escapeHtml(item.time)}</span>
          <span class="badge badge-green">已保存</span>
        </div>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}
