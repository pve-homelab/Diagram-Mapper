import { databaseUrl } from "@diagram-mapper/config";
import { runMigrations } from "../src/index.ts";

await runMigrations(databaseUrl());
process.stdout.write("migrations applied\n");
