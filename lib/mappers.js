// Field mappers: Supabase snake_case → camelCase for frontend.
// Extracted from server.js — behavior unchanged.

function mapQRow(q) {
  return {
    id: q.id,
    q: q.question_text,
    context: q.context,
    modelAnswer: q.model_answer,
    keyPoints: q.key_points || [],
    subject: q.subject,
    source: q.source,
    year: q.year,
    type: q.type || 'essay',
    isReal: true,
    pastBarId: q.batch_id,
    pastBarName: q.source,
    max: q.max_score || 10,
    // Cache fields — populated from DB, used by runEvalJob to skip redundant AI calls
    _cachedAlternatives: q.alternative_answers || null,
    _cachedAlac: q.model_answer_alac || null,
    _cachedConceptual: q.model_answer_conceptual || null,
    // Individual alternative answer columns
    alternativeAnswer1: q.alternative_answer_1 || null,
    alternativeAnswer2: q.alternative_answer_2 || null,
    alternativeAnswer3: q.alternative_answer_3 || null,
    alternativeAnswer4: q.alternative_answer_4 || null,
    alternativeAnswer5: q.alternative_answer_5 || null,
    // Alternative ALAC model answers
    alternativeAlac1: q.alternative_alac_1 || null,
    alternativeAlac2: q.alternative_alac_2 || null,
    alternativeAlac3: q.alternative_alac_3 || null,
    alternativeAlac4: q.alternative_alac_4 || null,
    alternativeAlac5: q.alternative_alac_5 || null,
  };
}

function mapUser(u) {
  if (!u) return null;
  return {
    id:                u.id,
    name:              u.name,
    email:             u.email,
    passwordHash:      u.password_hash,
    isAdmin:           u.is_admin || false,
    isActive:          u.is_active !== false,
    role:              u.is_admin ? 'admin' : 'student',
    active:            u.is_active !== false,
    status:            u.status || 'active',
    joinedAt:          u.joined_at,
    createdAt:         u.joined_at || u.registered_at,
    registeredAt:      u.registered_at || u.joined_at,
    tabSettings:       u.tab_settings || {},
    progress:          u.progress || {},
    activeExamSession: u.active_exam_session || null,
    mockBarCount:      u.mock_bar_count || 0,
    avgScore:          u.avg_score || 0,
    school:            u.school || null,
    spacedRepEnabled:  u.spaced_repetition_enabled !== false,
    customSubjectEnabled: u.custom_subject_enabled !== false,
    level:             u.level || 1,
    xp:                u.xp || 0,
    stats: { totalAttempts: u.mock_bar_count || 0, totalScore: 0, totalQuestions: 0 },
  };
}

function mapPastBar(pb) {
  if (!pb) return null;
  return {
    id:         pb.id,
    name:       pb.name,
    subject:    pb.subject,
    year:       pb.year,
    source:     pb.source,
    questions:  pb.questions || [],
    qCount:     pb.q_count || 0,
    uploadedAt: pb.uploaded_at,
    enabled:    pb.enabled !== false,  // default true
  };
}

function _mapResult(r) {
  return {
    ...r,
    userName:       r.users?.name  || r.user_id,
    userEmail:      r.users?.email || '',
    totalQuestions: r.total_questions,
    finishedAt:     r.finished_at,
    startedAt:      r.started_at   || null,
  };
}

module.exports = { mapQRow, mapUser, mapPastBar, _mapResult };
