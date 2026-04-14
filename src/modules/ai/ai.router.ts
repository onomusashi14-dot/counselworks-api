/**
 * src/modules/ai/ai.router.ts
 *
 * Six Claude-backed endpoints for CounselWorks paralegal workflows. None of
 * these are attorney-facing — the attorney NEVER sees AI output directly.
 * Every response passes through paralegal/supervisor review before reaching
 * the attorney portal.
 *
 * Mount point: /firms/:firmId/ai
 *
 * Endpoints:
 *   POST /threads/interpret       — classify an attorney instruction
 *   POST /documents/classify      — classify an uploaded document
 *   POST /summarize               — summarize a transcript or document
 *   POST /drafts/generate         — generate a first-draft document
 *   POST /cases/health-summary    — write a plain-language health paragraph
 *   POST /cases/missing-items     — detect likely-missing file contents
 *
 * All endpoints are behind authenticate + requireFirmAccess so firm isolation
 * is preserved. Every call is logged via ai-log.service regardless of outcome.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '../../config/prisma';
import { authenticate } from '../../middleware/authenticate';
import { requireFirmAccess } from '../../middleware/requireFirmAccess';
import { callClaude } from './ai-client';
import { logAICall } from './ai-log.service';

export const aiRouter = Router({ mergeParams: true });

// ─── TASK-SPECIFIC SYSTEM PROMPTS ────────────────────────────────────────────

export const INTERPRET_SYSTEM = `You are classifying an attorney's instruction to their paralegal team.

Given the attorney's message and case metadata, return a JSON object with:
{
  "request_type": one of ["records_request", "draft_request", "follow_up", "research", "scheduling", "client_communication", "general_instruction"],
  "intent": a 1-sentence summary of what the attorney wants done,
  "confidence": a number 0.0-1.0 representing your confidence in the classification,
  "suggested_task_title": a short action-oriented title for the task (e.g., "Request medical records from Dr. Park"),
  "suggested_eta_days": estimated business days to complete (integer),
  "needs_clarification": boolean — true if the instruction is too vague to act on,
  "clarification_question": if needs_clarification is true, what to ask the attorney (otherwise null)
}

Respond ONLY with the JSON object. No explanation, no markdown, no preamble.

Classification guidelines:
- "records_request" = requesting documents from providers, courts, employers, insurers
- "draft_request" = requesting a document be drafted (demand letter, motion, summary, etc.)
- "follow_up" = checking status of something already in progress
- "research" = requesting legal research or case law
- "scheduling" = requesting something be scheduled (deposition, hearing, meeting)
- "client_communication" = requesting contact with the client
- "general_instruction" = anything else

Confidence guidelines:
- 0.9+ = clear, specific instruction with obvious type
- 0.7-0.89 = clear intent but some ambiguity in scope
- 0.5-0.69 = vague instruction, could be multiple types
- Below 0.5 = too vague to classify reliably`;

export const CLASSIFY_SYSTEM = `You are classifying a legal document that was uploaded to a case file.

Given the file name, a text excerpt (up to 2000 characters), and case metadata, return:
{
  "document_type": one of ["medical_record", "billing_record", "police_report", "complaint", "answer", "discovery_response", "deposition_transcript", "expert_report", "correspondence", "insurance_document", "employment_record", "court_order", "motion", "declaration", "other"],
  "confidence": 0.0-1.0,
  "suggested_category": one of ["pleading", "medical", "billing", "evidence", "correspondence", "court_order"],
  "notes": a brief note about the document content (1 sentence max),
  "contains_phi": boolean — true if the document appears to contain protected health information
}

Respond ONLY with the JSON object.

If the text excerpt is too short or garbled to classify, set confidence below 0.5 and document_type to "other".

NEVER guess at specific medical details, diagnoses, or provider names that aren't in the text.`;

export const SUMMARIZE_SYSTEM = `You are summarizing a document or call transcript for a paralegal team.

Given the source text and summary type, return:
{
  "summary": a structured summary (3-8 sentences),
  "key_facts": array of key facts extracted (strings, max 10),
  "action_items": array of follow-up actions identified (strings, max 5),
  "missing_information": array of information gaps noticed (strings, max 5),
  "parties_mentioned": array of person/entity names mentioned (strings)
}

Respond ONLY with the JSON object.

Rules:
- Extract only facts that are explicitly stated in the source text
- NEVER infer, assume, or fabricate facts not present in the text
- If a date, amount, or name is unclear, note it in missing_information
- For medical records: do NOT diagnose, prognose, or interpret medical findings — only catalog what the record says
- For call transcripts: capture what was discussed and agreed, not what you think should happen next
- Keep the summary factual and neutral — no advocacy language`;

export const DRAFT_SYSTEM = `You are generating a first draft of a legal document for paralegal review. This draft will be reviewed and edited by a human before any attorney sees it.

Given the draft type, case facts, and instructions, return:
{
  "content": the full draft text,
  "placeholders": array of [MISSING: ...] placeholders used and what information is needed to fill them,
  "notes_for_reviewer": array of things the reviewing paralegal should verify or check (max 5),
  "word_count": approximate word count of the content
}

Respond ONLY with the JSON object.

MANDATORY RULES FOR DRAFT CONTENT:
1. Begin every draft with the header: "DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE."
2. Where ANY fact is not provided in the input, use [MISSING: description] — NEVER fabricate names, dates, amounts, addresses, medical details, or case numbers
3. Do NOT make legal arguments or legal conclusions — present facts and let the attorney add the legal analysis
4. Do NOT recommend settlement amounts, case valuations, or litigation strategy
5. For demand letters: present damages factually, do not calculate pain and suffering or general damages — use [MISSING: general damages amount per attorney]
6. For medical summaries: catalog what records show, do NOT interpret diagnoses or prognoses
7. Use formal, professional language appropriate for legal correspondence
8. Structure the document with clear sections and headings
9. California-specific: reference relevant code sections where instructed, but do NOT provide legal interpretation of those codes

DRAFT TYPES AND STRUCTURE:
- demand_letter: header, facts of incident, liability summary, damages (specials itemized, generals as [MISSING]), demand amount [MISSING], deadline, signature block
- medical_summary: patient info, treatment timeline (chronological), providers seen, diagnoses listed, current status, outstanding treatment
- chronology: date | event | source columns, chronological order, source citations
- case_fact_sheet: parties, incident summary, injuries, treatment, employment impact, insurance info, key dates
- declaration_shell: declarant info, foundation facts, exhibits referenced, signature block
- provider_communication: re: line, patient info, records requested, HIPAA authorization reference, return instructions
- client_communication: greeting, purpose, required items, deadline, contact info`;

export const HEALTH_SUMMARY_SYSTEM = `You are generating a plain-language case health summary for an attorney portal.

Given the case metadata and current operational status, write a 2-4 sentence prose paragraph that a managing attorney would read as a situation report. The paragraph should answer:
1. What is the current status of this case?
2. What is progressing well?
3. What is outstanding or blocked?
4. What is being done about any issues?

Return:
{
  "summary": "2-4 sentence paragraph in plain, professional English",
  "confidence": 0.0-1.0 based on how complete the input data was
}

Respond ONLY with the JSON object.

Rules:
- Write in third person about the CounselWorks team (e.g., "Maria Santos has collected...")
- Reference specific people by name when their actions are relevant
- Reference specific providers, documents, or deadlines by name when known
- Do NOT use legal jargon unnecessarily — write for a busy attorney scanning quickly
- Do NOT make predictions about case outcomes
- Do NOT recommend strategy
- If key information is missing from the input, say what is unknown rather than guessing
- Keep it factual and operational — this is a status report, not analysis`;

export const MISSING_ITEMS_SYSTEM = `You are analyzing a case file to identify missing items that should be present based on the case type and jurisdiction.

Given the case type, jurisdiction, list of documents already received, and current checklist status, return:
{
  "missing_items": [
    {
      "item": "name of the missing item",
      "priority": "critical" | "important" | "optional",
      "reason": "why this item is needed (1 sentence)",
      "typical_source": "where to obtain it (e.g., 'Request from treating physician')"
    }
  ],
  "completeness_assessment": "1-2 sentences on overall file completeness"
}

Respond ONLY with the JSON object.

Rules:
- Only flag items that are genuinely expected for this case type in this jurisdiction
- For California PI: police report, medical records from all treating providers, billing records, lost wage documentation, insurance policy, photos of injuries/property damage are standard
- For employment cases: personnel file, performance reviews, termination notice, EEOC charge, correspondence with HR are standard
- Do NOT flag items that are clearly phase-inappropriate (e.g., don't flag "trial exhibits" for an intake-phase case)
- Priority "critical" = case cannot advance without this item
- Priority "important" = should be obtained but case can proceed
- Priority "optional" = nice to have, not blocking
- NEVER fabricate item names that sound legal but aren't real (e.g., don't invent form names or code sections)`;

// ─── 1. POST /threads/interpret ───────────────────────────────────────────────
aiRouter.post(
  '/threads/interpret',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const userId = req.user!.id;
    const { message, caseId, caseMetadata } = (req.body ?? {}) as {
      message?: string;
      caseId?: string;
      caseMetadata?: { caseType?: string; jurisdiction?: string; phase?: string };
    };

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const userInput = JSON.stringify({
      attorney_instruction: message,
      case_type: caseMetadata?.caseType,
      jurisdiction: caseMetadata?.jurisdiction,
      case_phase: caseMetadata?.phase,
    });

    const result = await callClaude(INTERPRET_SYSTEM, userInput);
    await logAICall({
      firmId,
      caseId,
      endpoint: 'threads/interpret',
      triggeringUserId: userId,
      inputSummary: message.substring(0, 200),
      result,
    });

    if (!result.success) {
      // Supervisor fallback — never surface AI error to attorney.
      res.json({
        request_type: 'general_instruction',
        intent: message,
        confidence: 0,
        suggested_task_title: message.substring(0, 100),
        suggested_eta_days: 3,
        needs_clarification: false,
        clarification_question: null,
        routed_to_supervisor: true,
      });
      return;
    }

    const output = { ...result.output };
    if (typeof output.confidence !== 'number' || output.confidence < 0.5) {
      output.routed_to_supervisor = true;
    }
    res.json(output);
  },
);

// ─── 2. POST /documents/classify ──────────────────────────────────────────────
aiRouter.post(
  '/documents/classify',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const userId = req.user!.id;
    const { fileName, textExcerpt, caseType, jurisdiction, caseId } =
      (req.body ?? {}) as {
        fileName?: string;
        textExcerpt?: string;
        caseType?: string;
        jurisdiction?: string;
        caseId?: string;
      };

    const userInput = JSON.stringify({
      file_name: fileName,
      text_excerpt: (textExcerpt ?? '').substring(0, 2000),
      case_type: caseType,
      jurisdiction,
    });

    const result = await callClaude(CLASSIFY_SYSTEM, userInput);
    await logAICall({
      firmId,
      caseId,
      endpoint: 'documents/classify',
      triggeringUserId: userId,
      inputSummary: `Classifying: ${fileName ?? '(unknown)'}`,
      result,
    });

    if (!result.success) {
      res.json({
        document_type: 'other',
        confidence: 0,
        suggested_category: 'evidence',
        notes: 'Classification failed — manual review required',
        contains_phi: false,
      });
      return;
    }
    res.json(result.output);
  },
);

// ─── 3. POST /summarize ───────────────────────────────────────────────────────
aiRouter.post(
  '/summarize',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const userId = req.user!.id;
    const { text, summaryType, caseMetadata, caseId } = (req.body ?? {}) as {
      text?: string;
      summaryType?: string;
      caseMetadata?: { caseType?: string; jurisdiction?: string };
      caseId?: string;
    };

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const userInput = JSON.stringify({
      source_text: text.substring(0, 15_000),
      summary_type: summaryType ?? 'document_summary',
      case_type: caseMetadata?.caseType,
      jurisdiction: caseMetadata?.jurisdiction,
    });

    const result = await callClaude(SUMMARIZE_SYSTEM, userInput, { maxTokens: 3000 });
    await logAICall({
      firmId,
      caseId,
      endpoint: 'summarize',
      triggeringUserId: userId,
      inputSummary: `Summarizing ${summaryType ?? 'document_summary'}: ${text.substring(0, 100)}...`,
      result,
    });

    if (!result.success) {
      res.status(500).json({ error: 'Summarization failed' });
      return;
    }
    res.json(result.output);
  },
);

// ─── 4. POST /drafts/generate ─────────────────────────────────────────────────
aiRouter.post(
  '/drafts/generate',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const userId = req.user!.id;
    const {
      draftType,
      caseId,
      caseMetadata,
      jurisdictionNotes,
      documentSummaries,
      instructions,
    } = (req.body ?? {}) as {
      draftType?: string;
      caseId?: string;
      caseMetadata?: Record<string, unknown>;
      jurisdictionNotes?: string;
      documentSummaries?: unknown;
      instructions?: string;
    };

    if (!draftType) {
      res.status(400).json({ error: 'draftType is required' });
      return;
    }

    const userInput = JSON.stringify({
      draft_type: draftType,
      case_facts: caseMetadata,
      jurisdiction_notes: jurisdictionNotes,
      document_summaries: documentSummaries,
      special_instructions: instructions,
    });

    const result = await callClaude(DRAFT_SYSTEM, userInput, { maxTokens: 4096 });
    await logAICall({
      firmId,
      caseId,
      endpoint: 'drafts/generate',
      triggeringUserId: userId,
      inputSummary: `Generating ${draftType} for case ${caseId ?? '(none)'}`,
      result,
    });

    if (!result.success) {
      res.status(500).json({ error: 'Draft generation failed' });
      return;
    }

    // Mandatory label enforcement — prepend if Claude omitted it.
    const output = { ...result.output };
    if (
      typeof output.content === 'string' &&
      !output.content.includes('DRAFT —')
    ) {
      output.content =
        'DRAFT — PREPARED FOR ATTORNEY REVIEW ONLY. NOT LEGAL ADVICE.\n\n' +
        output.content;
    }
    res.json(output);
  },
);

// ─── 5. POST /cases/health-summary ────────────────────────────────────────────
aiRouter.post(
  '/cases/health-summary',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const userId = req.user!.id;
    const { caseId } = (req.body ?? {}) as { caseId?: string };

    if (!caseId) {
      res.status(400).json({ error: 'caseId is required' });
      return;
    }

    const caseData = await prisma.case.findFirst({
      where: { id: caseId, firmId, archivedAt: null },
      include: {
        checklistItems: { where: { archivedAt: null } },
        tasks: {
          where: { archivedAt: null, status: { in: ['open', 'in_progress'] } },
        },
        medicalRecordRequests: { where: { archivedAt: null } },
        requests: {
          where: { closedAt: null },
          include: {
            messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          },
        },
      },
    });

    if (!caseData) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const checklistTotal = caseData.checklistItems.filter((i) => i.required).length;
    const checklistCompleted = caseData.checklistItems.filter(
      (i) => i.required && i.status === 'complete',
    ).length;

    const userInput = JSON.stringify({
      client_name: caseData.clientName,
      case_type: caseData.caseType,
      jurisdiction: caseData.jurisdiction,
      phase: caseData.phase,
      health_status: caseData.healthStatus,
      readiness_score: caseData.readinessScore,
      checklist_completed: checklistCompleted,
      checklist_total: checklistTotal,
      open_tasks: caseData.tasks.map((t) => ({
        title: t.title,
        priority: t.priority,
        dueAt: t.dueAt,
      })),
      medical_record_requests: caseData.medicalRecordRequests.map((m) => ({
        provider: m.providerName,
        status: m.status,
        requested_date: m.createdAt,
        received_date: m.recordsReceivedAt,
      })),
      open_threads: caseData.requests.length,
    });

    const result = await callClaude(HEALTH_SUMMARY_SYSTEM, userInput);
    await logAICall({
      firmId,
      caseId,
      endpoint: 'cases/health-summary',
      triggeringUserId: userId,
      inputSummary: `Health summary for ${caseData.clientName}`,
      result,
    });

    if (!result.success) {
      res.json({
        summary: caseData.healthSummary ?? 'Health summary unavailable.',
        confidence: 0,
      });
      return;
    }

    // Persist the new summary. The schema has no healthConfidence column —
    // only healthSummary. Confidence is returned to the caller but not stored.
    if (typeof result.output.summary === 'string') {
      await prisma.case.update({
        where: { id: caseId },
        data: { healthSummary: result.output.summary },
      });
    }

    res.json(result.output);
  },
);

// ─── 6. POST /cases/missing-items ─────────────────────────────────────────────
aiRouter.post(
  '/cases/missing-items',
  authenticate,
  requireFirmAccess(),
  async (req: Request, res: Response): Promise<void> => {
    const { firmId } = req.firmContext!;
    const userId = req.user!.id;
    const { caseId } = (req.body ?? {}) as { caseId?: string };

    if (!caseId) {
      res.status(400).json({ error: 'caseId is required' });
      return;
    }

    const caseData = await prisma.case.findFirst({
      where: { id: caseId, firmId, archivedAt: null },
      include: {
        checklistItems: { where: { archivedAt: null } },
        files: { where: { archivedAt: null } },
      },
    });

    if (!caseData) {
      res.status(404).json({ error: 'Case not found' });
      return;
    }

    const userInput = JSON.stringify({
      case_type: caseData.caseType,
      jurisdiction: caseData.jurisdiction,
      phase: caseData.phase,
      documents_received: caseData.files.map((f) => ({
        name: f.originalName,
        type: f.documentType,
        category: f.category,
      })),
      checklist_items: caseData.checklistItems.map((i) => ({
        name: i.label,
        status: i.status,
        required: i.required,
      })),
    });

    const result = await callClaude(MISSING_ITEMS_SYSTEM, userInput);
    await logAICall({
      firmId,
      caseId,
      endpoint: 'cases/missing-items',
      triggeringUserId: userId,
      inputSummary: `Missing items for ${caseData.clientName} (${caseData.caseType})`,
      result,
    });

    if (!result.success) {
      res.json({ missing_items: [], completeness_assessment: 'Analysis unavailable.' });
      return;
    }
    res.json(result.output);
  },
);
