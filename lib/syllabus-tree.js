// Syllabus tree helpers — pure functions, no external dependencies.
// Extracted from server.js — behavior unchanged.

function generateId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

function findInChildren(children, id, parent) {
  for (const child of children) {
    if (child.id === id) return { node: child, parent };
    if (child.children?.length) {
      const found = findInChildren(child.children, id, child);
      if (found) return found;
    }
  }
  return null;
}

function findNodeById(sections, id) {
  for (const sec of sections) {
    if (sec.id === id) return { node: sec, parent: null };
    const found = findInChildren(sec.children || [], id, sec);
    if (found) return found;
  }
  return null;
}

function removeNodeById(sections, id) {
  const pdfsToDelete = [];
  function collectPdfs(node) {
    if (node.pdfId) pdfsToDelete.push(node.pdfId);
    (node.children || []).forEach(collectPdfs);
  }
  function removeFrom(arr) {
    const idx = arr.findIndex(n => n.id === id);
    if (idx !== -1) { collectPdfs(arr[idx]); arr.splice(idx, 1); return true; }
    for (const node of arr) {
      if (node.children?.length && removeFrom(node.children)) return true;
    }
    return false;
  }
  removeFrom(sections);
  return pdfsToDelete;
}

function getAllSubjectsWithSections() {
  return ['civil','criminal','political','labor','commercial','taxation','remedial','ethics','custom'];
}

function convertOldTopicsToSections(topics) {
  if (!topics || !topics.length) return [];
  return [{
    id: generateId('sec'),
    type: 'section',
    label: 'I',
    title: 'IMPORTED TOPICS',
    children: topics.map(t => ({
      id: generateId('top'),
      type: (t.children?.length || t.subtopics?.length) ? 'group' : 'topic',
      label: t.label || '?',
      title: t.name || t.title || 'Unknown Topic',
      pdfId: null,
      pdfName: null,
      children: ((t.children || []).concat(t.subtopics || [])).map(c => ({
        id: generateId('sub'),
        type: 'topic',
        label: c.label || '?',
        title: c.name || c.title || '',
        pdfId: null,
        pdfName: null,
        children: [],
      })),
    })),
  }];
}

function countAllTopics(topics) {
  let n = 0;
  function walk(items) { (items||[]).forEach(t => { n++; walk(t.subtopics); walk(t.children); }); }
  walk(topics);
  return n;
}

module.exports = {
  generateId,
  findInChildren,
  findNodeById,
  removeNodeById,
  getAllSubjectsWithSections,
  convertOldTopicsToSections,
  countAllTopics,
};
