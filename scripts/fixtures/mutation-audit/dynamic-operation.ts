const program = new Command();
const app = program.command("app");

app.command("restart").action(async (dynamicOperation) => {
  await client().call(dynamicOperation, { appId: "app-id" });
});
