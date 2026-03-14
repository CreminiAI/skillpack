# SkillApp - Orchestrate Skills into a Standalone App

One command to orchestrate [Skills](https://skills.sh), tools, mcps into a standalone app users can download and use on their own computer!

```bash
npx skillapp create
```

If skills, tools, and MCPs are like LEGO pieces, a skill app is the master piece that assembles them into a complete solution.

Each Skill App should organize different skills to address a well-defined problem or complete specific tasks. For example, research a company by gathering information from various sources and create a PowerPoint presentation based on the findings.

## Quick Start

### Create a Skill App Interactively

```bash
npx skillapp create
```

Step-by-Step

1. Set the app name and description
2. Add skills from a GitHub repos, URLs, or local paths
3. Add prompts to orchestrate and organize skills you added to accomplish tasks
4. (Optional) bundle the result as a zip

### Step-by-Step Commands

```bash
# Add skills
npx skillapp skills add vercel-labs/agent-skills --skill frontend-design
npx skillapp skills add ./my-local-skills

# Manage prompts
npx skillapp prompts add "Collect company data using Skill A, create charts from the data using Skill B, and compile the results into a PowerPoint using Skill C"
npx skillapp prompts list

# Package the current app
npx skillapp build
```

## Commands

| Command                  | Description                           |
| ------------------------ | ------------------------------------- |
| `create`                 | Create a skill app interactively      |
| `skills add <source>`    | Add a skill                           |
| `skills remove <name>`   | Remove a skill                        |
| `skills list`            | List installed skills                 |
| `prompts add <text>`     | Add a prompt                          |
| `prompts remove <index>` | Remove a prompt                       |
| `prompts list`           | List all prompts                      |
| `build`                  | Package the current app as a zip file |

## Zip Output

The extracted archive looks like this:

```text
skillapp/
├── app.json             # App configuration
├── skills/              # Collected SKILL.md files
├── server/              # Express backend
├── web/                 # Web chat UI
├── start.sh             # One-click launcher for macOS/Linux
├── start.bat            # One-click launcher for Windows
└── README.md
```

### Run the App

```bash
# macOS / Linux
chmod +x start.sh && ./start.sh

# Windows
start.bat
```

Then open [http://127.0.0.1:26313](http://127.0.0.1:26313), enter your API key, and start working and solving problems.

## Development

For development details, see [Development Guide](docs/development.md).

## License

MIT
