const program = new Command();
const app = program.command("app");

async function mutate(control: OpenCloudClient, run: MutationRun) {
  await control.patch(`/v1/apps/${run.appId}`, { enabled: true });
}

app.command("restart").action(async () => {
  await mutate(control, fakeRun);
});
