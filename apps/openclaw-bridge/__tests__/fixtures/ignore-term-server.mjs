console.log(`TEST_CHILD_READY pid=${process.pid}`);
process.on('SIGTERM', () => {
  console.log('TEST_CHILD_IGNORED_SIGTERM');
});
setInterval(() => {}, 1000);
