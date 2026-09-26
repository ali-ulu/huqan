// Tool approval statements, moved out of storage.js's _init (#2165).

function prepareToolApprovalStatements(db) {
  return {
    upsertToolApproval: db.prepare(`
      INSERT INTO tool_approvals (
        id, approval_key, tool, input, context_json, policy_json,
        status, decision, reason, workspace_id, created_at, updated_at, decided_at
      ) VALUES (
        @id, @approval_key, @tool, @input, @context_json, @policy_json,
        @status, @decision, @reason, @workspace_id, @created_at, @updated_at, @decided_at
      )
      ON CONFLICT(approval_key) DO UPDATE SET
        tool = excluded.tool,
        input = excluded.input,
        context_json = excluded.context_json,
        policy_json = excluded.policy_json,
        status = excluded.status,
        decision = excluded.decision,
        reason = excluded.reason,
        workspace_id = excluded.workspace_id,
        updated_at = excluded.updated_at,
        decided_at = excluded.decided_at
    `),
    insertToolApprovalIfAbsent: db.prepare(`
      INSERT INTO tool_approvals (
        id, approval_key, tool, input, context_json, policy_json,
        status, decision, reason, workspace_id, created_at, updated_at, decided_at
      ) VALUES (
        @id, @approval_key, @tool, @input, @context_json, @policy_json,
        @status, @decision, @reason, @workspace_id, @created_at, @updated_at, @decided_at
      ) ON CONFLICT(approval_key) DO NOTHING
    `),
    getToolApprovalByKey: db.prepare('SELECT * FROM tool_approvals WHERE approval_key = ? AND workspace_id = ? LIMIT 1'),
    getToolApprovalById: db.prepare('SELECT * FROM tool_approvals WHERE id = ? AND workspace_id = ? LIMIT 1'),
    listPendingToolApprovals: db.prepare(`
      SELECT *
      FROM tool_approvals
      WHERE workspace_id = ? AND status = 'pending'
      ORDER BY updated_at DESC
      LIMIT ?
    `),
    countPendingToolApprovals: db.prepare(`
      SELECT COUNT(*) AS c
      FROM tool_approvals
      WHERE workspace_id = ? AND status = 'pending'
    `),
    listUnresolvedToolApprovals: db.prepare(`
      SELECT *
      FROM tool_approvals
      WHERE workspace_id = ? AND status IN ('pending', 'executing', 'failed')
      ORDER BY updated_at DESC
      LIMIT ?
    `),
    countUnresolvedToolApprovals: db.prepare(`
      SELECT COUNT(*) AS c
      FROM tool_approvals
      WHERE workspace_id = ? AND status IN ('pending', 'executing', 'failed')
    `),
    // Keyset page for recoverExpiredToolApprovals (#426).
    //
    // Ordered by `id` rather than `updated_at`, and paged by cursor rather
    // than OFFSET: recovery writes `updated_at` on every row it fails, so an
    // updated_at-ordered OFFSET scan reorders rows mid-walk and silently
    // skips approvals that shifted past the window. `id` is the PRIMARY KEY
    // and recovery never rewrites it, so an id cursor stays stable.
    //
    // Narrowed to status = 'executing' because that is the only status the
    // recovery loop acts on; pending/failed rows were fetched and discarded
    // in JS before, which was the bulk of the scan.
    listExecutingToolApprovalsAfter: db.prepare(`
      SELECT *
      FROM tool_approvals
      WHERE status = 'executing' AND id > ?
      ORDER BY id
      LIMIT ?
    `),
    claimToolApproval: db.prepare(`
      UPDATE tool_approvals
      SET status = 'executing',
          decision = 'approved',
          reason = @reason,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'pending'
    `),
    // #1675: the PR Guardian executes an approval that is already
    // `approved`, not `pending`, so neither claim statement above could
    // consume it -- the row stayed `approved` across the GitHub call and a
    // repeated request posted the comment again. This statement is that
    // missing transition, and the `context_json = @expected_context_json`
    // guard is what makes it atomic: two concurrent executors read the same
    // context, both try to claim, and exactly one UPDATE matches.
    claimApprovedToolApproval: db.prepare(`
      UPDATE tool_approvals
      SET status = 'executing',
          reason = @reason,
          context_json = @context_json,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'approved'
        AND context_json = @expected_context_json
    `),
    claimToolApprovalWithLease: db.prepare(`
      UPDATE tool_approvals
      SET status = 'executing',
          decision = 'approved',
          reason = @reason,
          context_json = @context_json,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'pending'
    `),
    renewToolApprovalLease: db.prepare(`
      UPDATE tool_approvals
      SET context_json = @context_json,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'executing'
        AND context_json = @expected_context_json
    `),
    failExpiredToolApproval: db.prepare(`
      UPDATE tool_approvals
      SET status = 'failed',
          decision = 'execution_outcome_unknown',
          reason = @reason,
          decided_at = @decided_at,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'executing'
        AND context_json = @expected_context_json
    `),
    rejectToolApproval: db.prepare(`
      UPDATE tool_approvals
      SET status = 'rejected',
          decision = 'rejected',
          reason = @reason,
          decided_at = @decided_at,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'pending'
    `),
    failToolApproval: db.prepare(`
      UPDATE tool_approvals
      SET status = 'failed',
          decision = 'execution_outcome_unknown',
          reason = @reason,
          decided_at = @decided_at,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = 'executing'
    `),
    // The status guard is what makes an approval decision one-way (#422).
    // Without it this statement matched on `id` alone, so a second resolve
    // rewrote an already-finalized approval -- and because an unrecognized
    // decision maps to 'pending', it could drag an approved or rejected row
    // *backwards* into 'pending'.
    //
    // The guard is `IN ('pending','executing')`, not `= 'pending'`: the real
    // MCP approval path claims the row into 'executing' first
    // (claimToolApprovalWithLease), runs the action, and only then calls
    // resolveToolApproval to finalize it. Guarding on 'pending' alone would
    // break that legitimate finalization. 'approved', 'rejected' and 'failed'
    // are terminal and stay that way.
    resolveToolApproval: db.prepare(`
      UPDATE tool_approvals
      SET status = @status,
          decision = @decision,
          reason = @reason,
          decided_at = @decided_at,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status IN ('pending', 'executing')
    `),
    finalizeToolApprovalWithReceipt: db.prepare(`
      UPDATE tool_approvals
      SET status = @status,
          decision = @decision,
          reason = @reason,
          context_json = @context_json,
          decided_at = @decided_at,
          updated_at = @updated_at
      WHERE id = @id
        AND workspace_id = @workspace_id
        AND status = @expected_status
    `),
  };
}

module.exports = { prepareToolApprovalStatements };
