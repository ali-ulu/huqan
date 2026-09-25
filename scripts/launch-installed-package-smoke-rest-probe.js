'use strict';

function buildRestProbe({ serverPath, mcpPath, PARITY_CLAIM, PARITY_WORKSPACE, SMOKE_API_KEY, SMOKE_OPERATOR_TOKEN }) {
  return String.raw`
(async () => {
  const server = require(${JSON.stringify(serverPath)});
  const mcp = require(${JSON.stringify(mcpPath)});
  const claim = ${JSON.stringify(PARITY_CLAIM)};
  const workspaceId = ${JSON.stringify(PARITY_WORKSPACE)};
  const apiKey = ${JSON.stringify(SMOKE_API_KEY)};
  const operatorSecret = ${JSON.stringify(SMOKE_OPERATOR_TOKEN)};
  let listening = null;
  try {
    listening = server.startServer(0, '127.0.0.1');
    if (!listening.listening) {
      await new Promise((resolve, reject) => {
        listening.once('listening', resolve);
        listening.once('error', reject);
      });
    }
    const address = listening.address();
    const base = 'http://127.0.0.1:' + address.port;
    const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey };

    const healthResponse = await fetch(base + '/health');
    const health = await healthResponse.json();
    if (healthResponse.status !== 200 || health?.ok !== true || health?.service !== 'huqan') {
      throw new Error('health contract failed: ' + healthResponse.status + ' ' + JSON.stringify(health));
    }

    const viewerShellResponse = await fetch(base + '/viewer');
    const viewerShell = await viewerShellResponse.text();
    if (viewerShellResponse.status !== 200 || !/text\/html/i.test(viewerShellResponse.headers.get('content-type') || '') || !viewerShell.includes('HUQAN')) {
      throw new Error('viewer shell contract failed: ' + viewerShellResponse.status);
    }

    const unauthorized = await fetch(base + '/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim, workspaceId }),
    });
    if (unauthorized.status !== 401) {
      throw new Error('protected verify did not require API auth: ' + unauthorized.status);
    }

    const reviewResponse = await fetch(base + '/api/v2/workflows/learn', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId,
        text: claim,
        sourceType: 'upload',
        sourceRef: 'launch-smoke://rest-parity',
      }),
    });
    const review = await reviewResponse.json();
    const approvalId = review?.data?.approvalId;
    if (reviewResponse.status !== 202
      || review?.status !== 'review_required'
      || Number(review?.data?.learned || 0) !== 0
      || review?.data?.approval?.persisted !== true
      || typeof approvalId !== 'string' || approvalId.length === 0) {
      throw new Error('HTTP learn-review contract failed: ' + reviewResponse.status + ' ' + JSON.stringify(review));
    }

    const preGraphResponse = await fetch(base + '/graph-data?workspaceId=' + encodeURIComponent(workspaceId), {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    const preGraph = await preGraphResponse.json();
    if (preGraphResponse.status !== 200 || !Array.isArray(preGraph?.nodes) || preGraph.nodes.length !== 0) {
      throw new Error('reviewed HTTP learn mutated canonical graph before approval: ' + preGraphResponse.status + ' ' + JSON.stringify(preGraph));
    }

    const preVerifyResponse = await fetch(base + '/verify', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ claim, workspaceId }),
    });
    const preVerify = await preVerifyResponse.json();
    if (preVerifyResponse.status !== 200 || String(preVerify?.status || '').toLowerCase() === 'verified') {
      throw new Error('HTTP observed the claim as verified before approval: ' + preVerifyResponse.status + ' ' + JSON.stringify(preVerify));
    }

    const approvalArgs = { approvalId, workspaceId, decision: 'approved', reason: 'launch-smoke-parity' };
    const operatorCapability = mcp.createMcpOperatorCapability({
      secret: operatorSecret,
      ...mcp.operatorCapabilityBinding('huqan.approve', approvalArgs),
    });
    const decisionResponse = await fetch(base + '/api/v2/memory-approvals/' + encodeURIComponent(approvalId) + '/decision?workspaceId=' + encodeURIComponent(workspaceId), {
      method: 'POST',
      headers: {
        ...authHeaders,
        'x-huqan-operator-capability': operatorCapability,
      },
      body: JSON.stringify({ decision: 'approved', reason: 'launch-smoke-parity' }),
    });
    const decision = await decisionResponse.json();
    if (decisionResponse.status !== 200 || decision?.ok !== true || decision?.data?.executed !== true) {
      throw new Error('HTTP scoped approval failed: ' + decisionResponse.status + ' ' + JSON.stringify(decision));
    }
    const receipt = decision?.data?.receipt;
    if (!receipt?.receiptId) {
      throw new Error('HTTP approval returned no receipt: ' + JSON.stringify(decision));
    }

    const postVerifyResponse = await fetch(base + '/verify', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ claim, workspaceId }),
    });
    const postVerify = await postVerifyResponse.json();
    if (postVerifyResponse.status !== 200 || String(postVerify?.status || '').toLowerCase() !== 'verified') {
      throw new Error('HTTP approval did not make the claim verifiable: ' + postVerifyResponse.status + ' ' + JSON.stringify(postVerify));
    }

    const loginResponse = await fetch(base + '/viewer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ apiKey, workspaceId }),
    });
    const login = await loginResponse.json();
    const setCookie = loginResponse.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';', 1)[0];
    if (loginResponse.status !== 200 || login?.ok !== true || login?.workspaceId !== workspaceId || !cookie) {
      throw new Error('viewer login failed: ' + loginResponse.status + ' ' + JSON.stringify(login));
    }

    const viewerReceiptResponse = await fetch(base + '/viewer/api/trust-receipt/' + encodeURIComponent(receipt.receiptId) + '?workspaceId=' + encodeURIComponent(workspaceId), {
      headers: { cookie },
    });
    const viewerReceipt = await viewerReceiptResponse.json();
    if (viewerReceiptResponse.status !== 200 || viewerReceipt?.ok !== true
      || viewerReceipt?.receipt?.receiptId !== receipt.receiptId
      || viewerReceipt?.receipt?.approvalId !== approvalId) {
      throw new Error('authenticated viewer did not read the owned receipt: ' + viewerReceiptResponse.status + ' ' + JSON.stringify(viewerReceipt));
    }

    const crossWorkspaceResponse = await fetch(base + '/viewer/api/trust-receipt/' + encodeURIComponent(receipt.receiptId) + '?workspaceId=other-workspace', {
      headers: { cookie },
    });
    const crossWorkspace = await crossWorkspaceResponse.json();
    if (crossWorkspaceResponse.status !== 403 || crossWorkspace?.error?.code !== 'cross_workspace') {
      throw new Error('viewer session was not workspace-bound: ' + crossWorkspaceResponse.status + ' ' + JSON.stringify(crossWorkspace));
    }

    process.stdout.write(JSON.stringify({
      surface: 'rest',
      approvalId,
      receipt,
      refs: decision?.data?.refs || null,
      viewerReceipt: viewerReceipt.receipt,
      preApprovalVerified: false,
      postApprovalVerified: true,
    }) + '\n');
  } finally {
    if (listening?.listening) {
      await new Promise(resolve => listening.close(resolve));
    }
    try { server.closeHuqan?.(); } catch (_) {}
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
`;
}

module.exports = { buildRestProbe };
