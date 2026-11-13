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

// Global data caches
let cachedClasses = [];
let cachedSubmissions = [];
let currentMissingList = [];
let currentClassSummary = null;
let broadcastState = { active: false, className: '' };
let activeTab = 'submissions';

// Redirect back to login screen whenever any teacher API returns 401
const nativeFetch = window.fetch.bind(window);
window.fetch = async function (...args) {
  const res = await nativeFetch(...args);
  if (res.status === 401) {
    window.location.replace('/teacher');
  }
  return res;
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initTeacherSecurity();
  initServerInfo();
  initTabs();
  initClassesManagement();
  initMaterialsManagement();
  initSubmissionsManagement();

  // Auto-refresh submissions & broadcast state every 5 seconds while viewing submissions tab
  setInterval(() => {
    if (activeTab === 'submissions') {
      loadBroadcastState();
      if (broadcastState.active) {
        loadSubmissions(true);
      }
    }
  }, 5000);
});

// 1. Server Info
async function initServerInfo() {
  try {
    const res = await fetch('/api/info');
    const json = await res.json();
    if (json.success && json.data) {
      const el = document.getElementById('serverUrl');
      if (el) el.textContent = json.data.primaryUrl;
    }
  } catch (e) {
    console.error('获取服务地址失败:', e);
  }
}

// 2. Tab Navigation
function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetId = tab.dataset.tab;
      activeTab = targetId;
      document.getElementById('tabSubmissions').style.display = targetId === 'submissions' ? 'block' : 'none';
      document.getElementById('tabMaterials').style.display = targetId === 'materials' ? 'block' : 'none';
      document.getElementById('tabClasses').style.display = targetId === 'classes' ? 'block' : 'none';

      if (targetId === 'materials') loadMaterialsList();
      if (targetId === 'classes') loadClassesList();
      if (targetId === 'submissions') {
        loadSubmissions();
        loadBroadcastState();
      }
    });
  });
}

// 3. Submissions Management & Broadcast Control
function initSubmissionsManagement() {
  const filterSelect = document.getElementById('filterClassSelect');
  const searchKeyword = document.getElementById('searchKeyword');
  const btnRefresh = document.getElementById('btnRefreshSubmissions');
  const btnExportZip = document.getElementById('btnExportZip');
  const btnCopyMissing = document.getElementById('btnCopyMissing');
  const btnToggleBroadcast = document.getElementById('btnToggleBroadcast');
  const btnGlobalStopBroadcast = document.getElementById('btnGlobalStopBroadcast');
  const btnSwitchBroadcastClass = document.getElementById('btnSwitchBroadcastClass');

  if (filterSelect) {
    filterSelect.addEventListener('change', () => {
      loadSubmissions();
    });
  }

  if (searchKeyword) {
    searchKeyword.addEventListener('input', () => {
      renderSubmissionsTable();
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', () => {
      loadSubmissions();
      loadBroadcastState();
    });
  }

  if (btnExportZip) {
    btnExportZip.addEventListener('click', () => {
      const selectedClass = filterSelect ? filterSelect.value : '';
      const url = `/api/submissions/export-zip?class_name=${encodeURIComponent(selectedClass)}`;
      window.location.href = url;
    });
  }

  if (btnCopyMissing) {
    btnCopyMissing.addEventListener('click', () => {
      if (currentMissingList.length === 0) {
        alert('当前班级已全员交齐！');
        return;
      }
      const text = `未交学号: ${currentMissingList.join(', ')}`;
      navigator.clipboard.writeText(text).then(() => {
        alert(`已成功复制到剪贴板：\n${text}`);
      }).catch(() => {
        alert(text);
      });
    });
  }

  if (btnToggleBroadcast) {
    btnToggleBroadcast.addEventListener('click', async () => {
      const selectedClass = filterSelect ? filterSelect.value : '';
      if (!selectedClass) return;

      const isBroadcastingThis = broadcastState.active && broadcastState.className === selectedClass;
      if (isBroadcastingThis) {
        await stopBroadcast();
      } else {
        await startBroadcast(selectedClass);
      }
    });
  }

  if (btnGlobalStopBroadcast) {
    btnGlobalStopBroadcast.addEventListener('click', stopBroadcast);
  }

  if (btnSwitchBroadcastClass) {
    btnSwitchBroadcastClass.addEventListener('click', () => {
      if (broadcastState.active && broadcastState.className && filterSelect) {
        filterSelect.value = broadcastState.className;
        loadSubmissions();
      }
    });
  }

  // Initial load
  loadClassesForFilter().then(() => {
    loadSubmissions();
    loadBroadcastState();
  });
}

async function startBroadcast(className) {
  try {
    const res = await fetch('/api/broadcast/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_name: className })
    });
    const json = await res.json();
    if (json.success) {
      await loadBroadcastState();
      renderBroadcastButtons();
    } else {
      alert(json.message || '开启广播失败');
    }
  } catch (err) {
    alert('开启广播请求失败，请检查网络');
  }
}

async function stopBroadcast() {
  try {
    const res = await fetch('/api/broadcast/stop', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      await loadBroadcastState();
      renderBroadcastButtons();
    } else {
      alert(json.message || '停止广播失败');
    }
  } catch (err) {
    alert('停止广播请求失败，请检查网络');
  }
}

async function loadBroadcastState() {
  try {
    const res = await fetch('/api/broadcast');
    const json = await res.json();
    if (json.success && json.data) {
      broadcastState = json.data;
      renderActiveBroadcastBar();
      renderBroadcastButtons();
    }
  } catch (e) {
    // Silent
  }
}

function renderActiveBroadcastBar() {
  const bar = document.getElementById('activeBroadcastBar');
  const textEl = document.getElementById('activeBroadcastText');
  const switchBtn = document.getElementById('btnSwitchBroadcastClass');
  const filterClass = document.getElementById('filterClassSelect')?.value || '';
  if (!bar) return;

  if (!broadcastState.active || !broadcastState.className) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';
  textEl.textContent = `正在向所有学生端实时广播：【${broadcastState.className}】未交学号（已交 ${broadcastState.submittedCount}/${broadcastState.totalCount}，未交 ${broadcastState.missingCount} 人）`;
  if (switchBtn) {
    switchBtn.style.display = filterClass === broadcastState.className ? 'none' : 'inline-flex';
  }
}

function renderBroadcastButtons() {
  const btn = document.getElementById('btnToggleBroadcast');
  const filterClass = document.getElementById('filterClassSelect')?.value || '';
  if (!btn || !filterClass) return;

  const isBroadcastingThis = broadcastState.active && broadcastState.className === filterClass;
  if (isBroadcastingThis) {
    btn.className = 'btn btn-danger btn-sm';
    btn.textContent = '⏹️ 停止广播';
  } else {
    btn.className = 'btn btn-warning btn-sm';
    btn.textContent = broadcastState.active
      ? `📢 切换广播为【${filterClass}】`
      : '📢 广播未交学号到学生端';
  }
}

async function loadClassesForFilter() {
  const filterSelect = document.getElementById('filterClassSelect');
  if (!filterSelect) return;

  try {
    const res = await fetch('/api/classes');
    const json = await res.json();
    if (json.success && json.data) {
      cachedClasses = json.data;
      const currentVal = filterSelect.value;
      filterSelect.innerHTML = '<option value="">全部班级</option>';

      const gradeGroups = {
        '六年级': [],
        '七年级': [],
        '八年级': [],
        '其他班级': []
      };

      cachedClasses.forEach(cls => {
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
            opt.textContent = `${cls.name} (${cls.roster_count || cls.max_student_no || 45}人)`;
            groupEl.appendChild(opt);
          });
          filterSelect.appendChild(groupEl);
        }
      }

      if (currentVal && cachedClasses.some(c => c.name === currentVal)) {
        filterSelect.value = currentVal;
      }
    }
  } catch (e) {
    console.error('加载班级筛选失败:', e);
  }
}

async function loadSubmissions(silent = false) {
  const filterSelect = document.getElementById('filterClassSelect');
  const selectedClass = filterSelect ? filterSelect.value : '';
  const tbody = document.getElementById('submissionsTableBody');
  if (!silent && tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">
          正在加载作业数据...
        </td>
      </tr>
    `;
  }

  try {
    const reqs = [fetch(`/api/submissions?class_name=${encodeURIComponent(selectedClass)}`)];
    if (selectedClass) {
      reqs.push(fetch(`/api/teacher/class-summary?class_name=${encodeURIComponent(selectedClass)}`));
    }
    const responses = await Promise.all(reqs);
    const subJson = await responses[0].json();
    const sumJson = responses[1] ? await responses[1].json() : null;

    currentClassSummary = (sumJson && sumJson.success) ? sumJson.data : null;

    if (subJson.success && subJson.data) {
      cachedSubmissions = subJson.data;
      renderSubmissionsTable();
    }
  } catch (err) {
    if (!silent && tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; color: var(--danger); padding: 30px;">
            加载作业列表失败，请重试
          </td>
        </tr>
      `;
    }
  }
}

function renderSubmissionsTable() {
  const tbody = document.getElementById('submissionsTableBody');
  const keyword = (document.getElementById('searchKeyword')?.value || '').trim().toLowerCase();
  const filterClass = document.getElementById('filterClassSelect')?.value || '';

  let list = cachedSubmissions;
  if (keyword) {
    list = list.filter(item => {
      const noMatch = String(item.student_no).includes(keyword);
      const nameMatch = (item.student_name || '').toLowerCase().includes(keyword);
      const fileMatch = (item.original_name || '').toLowerCase().includes(keyword);
      return noMatch || nameMatch || fileMatch;
    });
  }

  const statCount = document.getElementById('statSubmittedCount');
  const statTotal = document.getElementById('statTotalStudents');
  const statUnsubmitted = document.getElementById('statUnsubmittedCount');
  const missingBox = document.getElementById('missingStudentsBox');
  const missingListEl = document.getElementById('missingStudentsList');
  const missingLabelEl = document.getElementById('missingClassLabel');

  if (statCount) statCount.textContent = `${list.length} 份`;

  if (filterClass) {
    let totalCount = 0;
    let missingDetails = [];

    if (currentClassSummary && currentClassSummary.className === filterClass) {
      totalCount = currentClassSummary.totalCount;
      missingDetails = currentClassSummary.missingDetails || [];
    } else {
      const clsInfo = cachedClasses.find(c => c.name === filterClass);
      const maxNo = clsInfo ? clsInfo.max_student_no : 45;
      totalCount = maxNo;
      const submittedSet = new Set(cachedSubmissions.map(s => Number(s.student_no)));
      for (let i = 1; i <= maxNo; i++) {
        if (!submittedSet.has(i)) {
          missingDetails.push({ student_no: i, student_name: '' });
        }
      }
    }

    currentMissingList = missingDetails.map(d => String(d.student_no).padStart(2, '0'));

    if (statTotal) statTotal.textContent = `${totalCount} 人`;
    if (statUnsubmitted) statUnsubmitted.textContent = `${missingDetails.length} 人`;

    if (missingBox) {
      missingBox.style.display = 'flex';
      missingLabelEl.textContent = `📢 【${filterClass}】未交名单 (${missingDetails.length}人):`;
      if (missingDetails.length === 0) {
        missingListEl.textContent = '全员已交齐！🎉';
      } else {
        missingListEl.textContent = missingDetails
          .map(d => {
            const p = String(d.student_no).padStart(2, '0');
            return d.student_name ? `${p}号(${d.student_name})` : `${p}号`;
          })
          .join('、');
      }
      renderBroadcastButtons();
    }
  } else {
    if (statTotal) statTotal.textContent = '-';
    if (statUnsubmitted) statUnsubmitted.textContent = '-';
    if (missingBox) missingBox.style.display = 'none';
  }

  if (!list || list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 40px;">
          暂无符合条件的作业提交记录
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  list.forEach(item => {
    const paddedNo = String(item.student_no).padStart(2, '0');
    const safeNote = escapeHtml(item.note || '');
    const noteBadge = item.note ? `<span title="${safeNote}" style="cursor:help; margin-left: 4px; color: #d97706;">💬</span>` : '';

    html += `
      <tr>
        <td><span class="badge badge-blue">${escapeHtml(item.class_name)}</span></td>
        <td><strong>${paddedNo} 号</strong></td>
        <td>${item.student_name ? escapeHtml(item.student_name) : '<span style="color:var(--text-muted);">未署名</span>'}</td>
        <td>
          <div style="font-weight: 600; word-break: break-all;">
            ${escapeHtml(item.original_name)} ${noteBadge}
          </div>
          ${item.note ? `<div style="font-size: 11px; color: #b45309; margin-top: 2px;">备注: ${safeNote}</div>` : ''}
        </td>
        <td><span class="badge badge-gray">${formatBytes(item.file_size)}</span></td>
        <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(formatDate(item.updated_at || item.submitted_at))}</td>
        <td style="font-size: 12px; color: var(--text-muted);">${escapeHtml(item.ip_address || '-')}</td>
        <td style="text-align: center;">
          <a href="/api/submissions/download/${item.id}" class="btn btn-outline btn-sm" download>
            ⬇️ 下载
          </a>
          <button type="button" class="btn btn-danger btn-sm" style="margin-left: 4px;" onclick="deleteSubmissionItem(${item.id})">
            🗑️
          </button>
        </td>
      </tr>
    `;
  });
  tbody.innerHTML = html;
}

async function deleteSubmissionItem(id) {
  if (!confirm('确定要删除这条作业提交记录及对应文件吗？删除后不可恢复。')) return;
  try {
    const res = await fetch(`/api/submissions/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      loadSubmissions();
      loadBroadcastState();
    } else {
      alert(json.message || '删除失败');
    }
  } catch (err) {
    alert('请求失败，请检查网络');
  }
}

// 4. Materials Management (Upload assignment & handouts)
function initMaterialsManagement() {
  const form = document.getElementById('uploadMaterialForm');
  const fileInput = document.getElementById('materialFileInput');
  const fileInfo = document.getElementById('materialFileInfo');
  const fileName = document.getElementById('materialFileName');
  const fileSize = document.getElementById('materialFileSize');
  const dropzone = document.getElementById('materialDropzone');
  const btnRefresh = document.getElementById('btnRefreshTeacherMaterials');

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

  if (btnRefresh) {
    btnRefresh.addEventListener('click', loadMaterialsList);
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = fileInput.files[0];
      if (!file) {
        showMaterialNotice('error', '请选择要上传的文件');
        return;
      }

      const title = (document.getElementById('materialTitle').value || '').trim();
      const formData = new FormData();
      formData.append('title', title);
      formData.append('file', file);

      const btnUpload = document.getElementById('btnUploadMaterial');
      const btnUploadText = document.getElementById('btnUploadMaterialText');
      btnUpload.disabled = true;
      btnUploadText.textContent = '⏳ 上传中...';

      try {
        const res = await fetch('/api/materials', {
          method: 'POST',
          body: formData
        });
        const json = await res.json();
        if (json.success) {
          showMaterialNotice('success', `✅ 文件《${escapeHtml(file.name)}》已成功发布，学生可在学生端随时下载！`);
          form.reset();
          fileInfo.style.display = 'none';
          loadMaterialsList();
        } else {
          showMaterialNotice('error', escapeHtml(json.message || '上传失败'));
        }
      } catch (err) {
        showMaterialNotice('error', '网络异常或上传错误');
      } finally {
        btnUpload.disabled = false;
        btnUploadText.textContent = '🚀 立即发布文件';
      }
    });
  }
}

function showMaterialNotice(type, msg) {
  const el = document.getElementById('materialNotice');
  if (!el) return;
  el.className = `notice notice-${type}`;
  el.innerHTML = msg;
  el.style.display = 'flex';
}

async function loadMaterialsList() {
  const tbody = document.getElementById('materialsTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/materials');
    const json = await res.json();

    if (!json.success || !json.data || json.data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 40px;">
            暂无已发布的学习资料或作业文件
          </td>
        </tr>
      `;
      return;
    }

    let html = '';
    json.data.forEach(item => {
      html += `
        <tr>
          <td>
            <div style="font-weight: 600; color: var(--text-main);">${escapeHtml(item.title)}</div>
            <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(item.original_name)}</div>
          </td>
          <td><span class="badge badge-gray">${formatBytes(item.file_size)}</span></td>
          <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(formatDate(item.created_at))}</td>
          <td style="text-align: center;">
            <a href="/api/materials/download/${item.id}" class="btn btn-outline btn-sm" download>
              ⬇️ 下载测试
            </a>
            <button type="button" class="btn btn-danger btn-sm" style="margin-left: 6px;" onclick="deleteMaterialItem(${item.id})">
              🗑️ 删除
            </button>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--danger); padding: 30px;">
          加载资料列表失败
        </td>
      </tr>
    `;
  }
}

async function deleteMaterialItem(id) {
  if (!confirm('确定要从发布列表中删除此文件吗？学生将无法再下载该文件。')) return;
  try {
    const res = await fetch(`/api/materials/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      loadMaterialsList();
    } else {
      alert(json.message || '删除失败');
    }
  } catch (err) {
    alert('操作失败');
  }
}

// 5. Classes & Roster Management
function initClassesManagement() {
  const form = document.getElementById('addClassForm');
  const rosterForm = document.getElementById('importRosterForm');
  const classesTbody = document.getElementById('classesTableBody');

  if (classesTbody) {
    classesTbody.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = Number(btn.dataset.id);
      const name = btn.dataset.name || '';
      const maxNo = Number(btn.dataset.max || 45);
      if (action === 'edit') {
        editClassMaxNo(id, name, maxNo);
      } else if (action === 'delete') {
        deleteClassItem(id, name);
      }
    });
  }

  if (rosterForm) {
    rosterForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('rosterFileInput');
      const file = fileInput?.files?.[0];
      if (!file) {
        showRosterNotice('error', '请先选择 Excel 名单文件');
        return;
      }

      const btn = document.getElementById('btnImportRoster');
      const btnText = document.getElementById('btnImportRosterText');
      btn.disabled = true;
      btnText.textContent = '⏳ 正在解析导入...';

      try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/roster/import', {
          method: 'POST',
          body: formData
        });
        const json = await res.json();
        if (json.success) {
          showRosterNotice('success', `✅ ${escapeHtml(json.message)}`);
          rosterForm.reset();
          loadClassesList();
          loadClassesForFilter();
        } else {
          showRosterNotice('error', escapeHtml(json.message || '导入失败'));
        }
      } catch (err) {
        showRosterNotice('error', '上传或导入请求失败');
      } finally {
        btn.disabled = false;
        btnText.textContent = '📊 导入并更新内置名单';
      }
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (document.getElementById('newClassName').value || '').trim();
      const maxNo = parseInt(document.getElementById('newClassMaxNo').value, 10) || 45;

      if (!name) {
        showClassNotice('error', '请输入班级名称');
        return;
      }

      try {
        const res = await fetch('/api/classes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, max_student_no: maxNo })
        });
        const json = await res.json();
        if (json.success) {
          showClassNotice('success', `✅ 班级【${escapeHtml(name)}】添加成功！`);
          form.reset();
          document.getElementById('newClassMaxNo').value = 45;
          loadClassesList();
          loadClassesForFilter();
        } else {
          showClassNotice('error', escapeHtml(json.message || '添加失败'));
        }
      } catch (err) {
        showClassNotice('error', '添加班级请求失败');
      }
    });
  }
}

function showRosterNotice(type, msg) {
  const el = document.getElementById('rosterNotice');
  if (!el) return;
  el.className = `notice notice-${type}`;
  el.innerHTML = msg;
  el.style.display = 'flex';
}

function showClassNotice(type, msg) {
  const el = document.getElementById('classNotice');
  if (!el) return;
  el.className = `notice notice-${type}`;
  el.innerHTML = msg;
  el.style.display = 'flex';
}

async function loadClassesList() {
  const tbody = document.getElementById('classesTableBody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/classes');
    const json = await res.json();

    if (!json.success || !json.data || json.data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 40px;">
            暂无班级，请在上方导入名单或添加新班级
          </td>
        </tr>
      `;
      return;
    }

    cachedClasses = json.data;
    let html = '';
    cachedClasses.forEach((cls, idx) => {
      const rosterBadge = cls.roster_count > 0
        ? `<span class="badge badge-green">已导入 ${cls.roster_count} 人</span>`
        : `<span class="badge badge-gray">未导入姓名</span>`;
      const safeName = escapeHtml(cls.name);
      html += `
        <tr>
          <td>${idx + 1}</td>
          <td><strong>${safeName}</strong></td>
          <td>01 号 ~ ${String(cls.max_student_no).padStart(2, '0')} 号 (共 ${cls.max_student_no} 人)</td>
          <td>${rosterBadge}</td>
          <td style="font-size: 13px; color: var(--text-muted);">${escapeHtml(formatDate(cls.created_at))}</td>
          <td style="text-align: center;">
            <button type="button" class="btn btn-outline btn-sm" data-action="edit" data-id="${cls.id}" data-name="${safeName}" data-max="${cls.max_student_no}">
              ✏️ 改人数
            </button>
            <button type="button" class="btn btn-outline btn-sm" style="color: var(--danger); border-color: #fecaca; margin-left: 4px;" data-action="delete" data-id="${cls.id}" data-name="${safeName}">
              🗑️ 删除
            </button>
          </td>
        </tr>
      `;
    });
    tbody.innerHTML = html;
  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--danger); padding: 30px;">
          加载班级列表失败
        </td>
      </tr>
    `;
  }
}

async function editClassMaxNo(id, name, currentMax) {
  const input = prompt(`修改【${name}】的班级人数（学号上限，1~120）：`, String(currentMax));
  if (input === null) return;
  const maxNo = parseInt(input, 10);
  if (!maxNo || isNaN(maxNo) || maxNo < 1 || maxNo > 120) {
    alert('请输入 1 到 120 之间的有效人数');
    return;
  }
  try {
    const res = await fetch(`/api/classes/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_student_no: maxNo })
    });
    const json = await res.json();
    if (json.success) {
      loadClassesList();
      loadClassesForFilter();
    } else {
      alert(json.message || '修改失败');
    }
  } catch (err) {
    alert('网络异常');
  }
}

async function deleteClassItem(id, name) {
  if (!confirm(`确定要删除班级【${name}】吗？已提交的作业记录仍会保留。`)) return;
  try {
    const res = await fetch(`/api/classes/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      loadClassesList();
      loadClassesForFilter();
    } else {
      alert(json.message || '删除班级失败');
    }
  } catch (err) {
    alert('网络异常');
  }
}

function showPasswordNotice(type, msg) {
  const el = document.getElementById('passwordNotice');
  if (!el) return;
  el.className = `notice notice-${type}`;
  el.textContent = msg;
  el.style.display = 'flex';
}

function initTeacherSecurity() {
  const logoutBtn = document.getElementById('btnTeacherLogout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await nativeFetch('/api/teacher/logout', { method: 'POST' });
      } finally {
        window.location.replace('/teacher');
      }
    });
  }

  const pwdForm = document.getElementById('changePasswordForm');
  if (pwdForm) {
    pwdForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPassword = document.getElementById('oldPasswordInput').value;
      const newPassword = document.getElementById('newPasswordInput').value;
      const confirmPassword = document.getElementById('confirmPasswordInput').value;

      if (newPassword.length < 4 || newPassword.length > 64) {
        showPasswordNotice('error', '新密码长度请设为 4 到 64 位');
        return;
      }
      if (newPassword !== confirmPassword) {
        showPasswordNotice('error', '两次输入的新密码不一致');
        return;
      }

      try {
        const res = await fetch('/api/teacher/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            old_password: oldPassword,
            new_password: newPassword
          })
        });
        const json = await res.json();
        if (json.success) {
          showPasswordNotice('success', '✅ 教师管理密码已修改，其他浏览器下次操作需重新登录。');
          pwdForm.reset();
        } else {
          showPasswordNotice('error', json.message || '修改失败');
        }
      } catch (err) {
        showPasswordNotice('error', '网络异常，修改失败');
      }
    });
  }
}
