export async function completionCommand(shell: string): Promise<void> {
  if (shell !== 'bash' && shell !== 'zsh') {
    console.error('Error: Shell must be either "bash" or "zsh"');
    process.exit(1);
  }

  const script = shell === 'bash' ? generateBashCompletion() : generateZshCompletion();
  console.log(script);
}

function generateBashCompletion(): string {
  return `# Ralph CLI bash completion

_ralph_completion() {
  local cur prev commands
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  commands="start batch-start status list stop merge finalize update retry reset-stagnation watch stats completion"

  case "\${prev}" in
    ralph)
      COMPREPLY=( $(compgen -W "\${commands}" -- \${cur}) )
      return 0
      ;;
    start|batch-start)
      COMPREPLY=( $(compgen -f -X '!*.@(md|json)' -- \${cur}) )
      return 0
      ;;
    status|stop|merge|finalize|stats|reset-stagnation|retry|update)
      local task_ids=$(ralph list 2>/dev/null | grep -oE 'task-[0-9]+-[a-z0-9]+' | sort -u)
      COMPREPLY=( $(compgen -W "\${task_ids}" -- \${cur}) )
      return 0
      ;;
    --repo|--ez4ielts-dir)
      COMPREPLY=( $(compgen -d -- \${cur}) )
      return 0
      ;;
    --backend)
      COMPREPLY=( $(compgen -W "cli sdk-runner" -- \${cur}) )
      return 0
      ;;
    --agent)
      COMPREPLY=( $(compgen -W "claude codex" -- \${cur}) )
      return 0
      ;;
    --status)
      COMPREPLY=( $(compgen -W "pending running ready_to_finalize finalizing completed failed failed_finalize stagnant" -- \${cur}) )
      return 0
      ;;
    --strategy)
      COMPREPLY=( $(compgen -W "ours theirs manual" -- \${cur}) )
      return 0
      ;;
    --format)
      COMPREPLY=( $(compgen -W "json table summary" -- \${cur}) )
      return 0
      ;;
  esac

  case "\${cur}" in
    -*)
      local opts="--repo --agent --backend --status --auto --strategy --target --format --all --interval --auto-ingest-ez4ielts --ez4ielts-dir --story-id --passes --notes --detailed --help"
      COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
      return 0
      ;;
  esac
}

complete -F _ralph_completion ralph
`;
}

function generateZshCompletion(): string {
  return `#compdef ralph
# Ralph CLI zsh completion

_ralph() {
  local -a commands
  commands=(
    'start:Start a new task from a PRD file'
    'batch-start:Start multiple tasks from PRD files'
    'status:Show status of a task or all running tasks'
    'list:List all tasks'
    'stop:Stop a running task'
    'merge:Merge a completed task'
    'finalize:Commit task changes using the restricted finisher flow'
    'update:Update a task or user story status'
    'retry:Retry a failed or stopped task'
    'reset-stagnation:Reset stagnation counters for a task'
    'watch:Poll the queue and optionally auto-ingest new PRDs'
    'stats:Show performance statistics for a task'
    'completion:Generate shell completion script'
  )

  local -a task_ids
  task_ids=(\${(f)"$(ralph list 2>/dev/null | grep -oE 'task-[0-9]+-[a-z0-9]+' | sort -u)"})

  _arguments -C \\
    '1: :->command' \\
    '*:: :->args'

  case $state in
    command)
      _describe 'ralph commands' commands
      ;;
    args)
      case $words[1] in
        start)
          _arguments \\
            '1:PRD file:_files -g "*.md|*.json"' \\
            '--repo[Repository path]:directory:_directories' \\
            '--agent[Agent to use]:agent:(claude codex)' \\
            '--backend[Backend to use]:backend:(cli sdk-runner)'
          ;;
        batch-start)
          _arguments \\
            '*:PRD file:_files -g "*.md|*.json"' \\
            '--repo[Repository path]:directory:_directories' \\
            '--agent[Agent to use]:agent:(claude codex)' \\
            '--backend[Backend to use]:backend:(cli sdk-runner)'
          ;;
        status)
          _arguments \\
            '1:task ID:(\${task_ids})' \\
            '--detailed[Show detailed task status]'
          ;;
        stop|merge|finalize|retry|reset-stagnation|update)
          _arguments \\
            '1:task ID:(\${task_ids})' \\
            '--auto[Auto-resolve conflicts]' \\
            '--strategy[Conflict resolution strategy]:strategy:(ours theirs manual)' \\
            '--target[Target branch]:branch:' \\
            '--story-id[User story ID]:story id:' \\
            '--passes[Mark story as passing]' \\
            '--notes[Implementation notes]:notes:'
          ;;
        stats)
          _arguments \\
            '1:task ID:(\${task_ids})' \\
            '--format[Output format]:format:(json table summary)' \\
            '--all[Show stats for all tasks]'
          ;;
        list)
          _arguments \\
            '--status[Filter by status]:status:(pending running ready_to_finalize finalizing completed failed failed_finalize stagnant)'
          ;;
        watch)
          _arguments \\
            '--interval[Polling interval in milliseconds]:interval:' \\
            '--repo[Repository path for auto-ingested tasks]:directory:_directories' \\
            '--agent[Agent to use for auto-ingested tasks]:agent:(claude codex)' \\
            '--backend[Backend to use for auto-ingested tasks]:backend:(cli sdk-runner)' \\
            '--auto-ingest-ez4ielts[Auto-enqueue new ez4ielts PRDs]' \\
            '--ez4ielts-dir[Directory to scan for ez4ielts PRDs]:directory:_directories'
          ;;
        completion)
          _arguments \\
            '1:shell:(bash zsh)'
          ;;
      esac
      ;;
  esac
}

_ralph "$@"
`;
}
