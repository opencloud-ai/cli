const program = new Command();
const app = program.command("app");

app.command("restart").action(async () => {
  const unrelated = { commandId: "opencloud app restart" };
  await client().delete(`/v1/apps/${appId}`);
});
