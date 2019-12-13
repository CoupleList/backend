import * as bodyparser from "body-parser";
import cors from "cors";
import express, { Application } from "express";

const app: Application = express() as Application;

app.use(bodyparser.urlencoded({ extended: false }));
app.use(bodyparser.json());
app.use(cors());

app.get("/*", (_: express.Request, res: express.Response) => {
  res.send("Hello, World!");
});

app.listen(3000);
