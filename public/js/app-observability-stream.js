'use strict';
window.HUQAN_OBS_STREAM = ({workspace,headers,appendEvent,loadAll,setStatus,T,STREAM_BASE_RECONNECT_DELAY_MS,STREAM_MAX_RECONNECT_DELAY_MS}) => {
  function connectStream() {
    if (window.__huqanObservabilityStream) window.__huqanObservabilityStream.close();
    const streamState = { closed: false, retryAttempt: 0, controller: null, timer: null, close: null };
    streamState.close = () => {
      streamState.closed = true;
      if (streamState.timer) clearTimeout(streamState.timer);
      if (streamState.controller) streamState.controller.abort();
    };
    window.__huqanObservabilityStream = streamState;
    const open = () => {
      if (streamState.closed) return;
      const controller = new AbortController();
      streamState.controller = controller;
      const query = new URLSearchParams({ workspaceId: workspace() });
      fetch(`/api/observability/stream?${query.toString()}`, { headers: headers(), signal: controller.signal, cache: 'no-store' }).then(async response => {
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted && !streamState.closed) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('stream closed by server');
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split('\\n\\n');
          buffer = frames.pop() || '';
          for (const frame of frames) {
            const data = frame.split('\\n').find(line => line.startsWith('data: '));
            if (!data) continue;
            try {
              const event = JSON.parse(data.slice(6));
              if (event.eventType && appendEvent(event)) {
                streamState.retryAttempt = 0;
                loadAll();
              }
            } catch (_) {}
          }
        }
      }).catch(error => {
        if (streamState.closed || controller.signal.aborted) return;
        const delay = Math.min(STREAM_BASE_RECONNECT_DELAY_MS * (2 ** Math.min(streamState.retryAttempt, 4)), STREAM_MAX_RECONNECT_DELAY_MS);
        streamState.retryAttempt += 1;
        setStatus(T('observabilityStatus.reconnect', `Reconnecting live stream in ${delay} ms…`, { delay }));
        streamState.timer = setTimeout(() => { streamState.timer = null; open(); }, delay);
      });
    };
    open();
  }

  return connectStream;
};
