const program = new Command();
const app = program.command("app");

app.command("restart").action(async (appId) => {
  const target = `/v1/apps/${appId}/restart`;
  await control.delete(target);
});
