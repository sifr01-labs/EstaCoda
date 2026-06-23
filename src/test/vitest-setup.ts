import { installIsolatedStateHome } from "./state-home.js";

process.env.ESTACODA_TEST_ORIGINAL_HOME ??= process.env.HOME;
installIsolatedStateHome();
