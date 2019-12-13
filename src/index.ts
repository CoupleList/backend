import * as bodyparser from "body-parser";
import * as cors from "cors";
import * as express from "express";

const app: express.Application = express();

app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(cors());

app.get("/*", (_: express.Request, res: express.Response) => {
  res.send("Hello, World!");
});

app.listen(3000);
