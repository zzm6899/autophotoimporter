if (typeof process.send !== 'function') throw new Error('fixture must be forked with IPC');

process.send({ type: 'ready' });
process.on('message', (request) => {
  if (!request || request.type !== 'prepare') return;
  process.send({
    type: 'stage', id: request.id, imagePath: request.imagePath, stage: 'decode-resize',
  });
  if (request.testMode === 'hang') return;
  process.send({
    type: 'result',
    id: request.id,
    imagePath: request.imagePath,
    payload: {
      detectorCHW: new Float32Array(0),
      sourceWidth: 4,
      sourceHeight: 3,
    },
  });
});
