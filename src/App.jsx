
import { useState, useEffect, useRef, useCallback } from "react";

const QUESTION_BANK = [
  { id:"q1",  category:"behavioral",  difficulty:1, text:"Tell me about yourself and what draws you to this role.", maxTime:120, minExpectedTokens:80 },
  { id:"q2",  category:"behavioral",  difficulty:1, text:"What's your biggest professional strength and how have you applied it recently?", maxTime:90,  minExpectedTokens:60 },
  { id:"q3",  category:"behavioral",  difficulty:2, text:"Describe a time you faced a significant challenge at work and how you resolved it.", maxTime:180, minExpectedTokens:120 },
  { id:"q4",  category:"behavioral",  difficulty:2, text:"Tell me about a time you had to lead a team through uncertainty or conflict.", maxTime:180, minExpectedTokens:120 },
  { id:"q5",  category:"technical",   difficulty:2, text:"Walk me through how you would design a scalable RESTful API for a high-traffic application.", maxTime:240, minExpectedTokens:150 },
  { id:"q6",  category:"technical",   difficulty:3, text:"Explain the CAP theorem and describe how you've navigated those tradeoffs in practice.", maxTime:240, minExpectedTokens:180 },
  { id:"q7",  category:"situational", difficulty:2, text:"A critical production incident surfaces 30 minutes before a major release. Walk me through exactly what you do.", maxTime:150, minExpectedTokens:100 },
  { id:"q8",  category:"situational", difficulty:3, text:"Your engineering team strongly disagrees with your proposed architecture. How do you move forward?", maxTime:150, minExpectedTokens:100 },
  { id:"q9",  category:"technical",   difficulty:3, text:"Describe the tradeoffs between microservices and monolithic architectures — when would you choose each?", maxTime:240, minExpectedTokens:160 },
  { id:"q10", category:"behavioral",  difficulty:3, text:"Tell me about the most impactful technical decision you've made and its long-term effects.", maxTime:210, minExpectedTokens:140 },
  { id:"q11", category:"situational", difficulty:1, text:"How do you prioritize when you have multiple competing deadlines?", maxTime:90,  minExpectedTokens:70 },
  { id:"q12", category:"technical",   difficulty:1, text:"Explain the difference between synchronous and asynchronous programming with a concrete example.", maxTime:120, minExpectedTokens:80 },
];

const TERMINATION_RULES = { consecutiveSkips:2, minScoreThreshold:25, consecutiveLowScores:3, lowScoreCutoff:40, maxQuestions:8, maxDurationMinutes:30 };

const CAT_META = {
  behavioral:  { color:"#7F77DD", bg:"#EEEDFE", text:"#3C3489", icon:"ti-user" },
  technical:   { color:"#1D9E75", bg:"#E1F5EE", text:"#085041", icon:"ti-code" },
  situational: { color:"#D85A30", bg:"#FAECE7", text:"#712B13", icon:"ti-bolt" },
};

const DIFF_LABEL = ["","Entry","Mid","Senior"];

function scoreResponse(response, question, timeTaken) {
  if (!response || response.trim().length === 0) return { total:0, breakdown:{}, flags:["NO_RESPONSE"] };
  const words = response.trim().split(/\s+/).length;
  const flags = [];
  const relevance = (() => {
    const kw = question.text.toLowerCase().split(" ").filter(w=>w.length>4);
    const hits = kw.filter(w=>response.toLowerCase().includes(w)).length;
    return Math.round(50 + Math.min(hits/Math.max(kw.length,1),1)*50);
  })();
  const depth = (() => {
    const ratio = Math.min(words/question.minExpectedTokens,1.4);
    if(ratio<0.3){flags.push("TOO_SHORT");return 30;}
    if(ratio>1.3){flags.push("TOO_VERBOSE");return Math.max(60,100-(ratio-1.3)*50);}
    return Math.round(50+ratio*35);
  })();
  const clarity = (() => {
    const sentences = response.split(/[.!?]+/).filter(s=>s.trim().length>10);
    const avg = words/Math.max(sentences.length,1);
    if(avg>40) return 55;
    if(avg<8)  return 60;
    return Math.min(95,65+sentences.length*3);
  })();
  const examples = (() => {
    const markers = ["for example","for instance","specifically","in my experience","i worked","i led","we implemented","the result was","which resulted","this led to","one time","at my previous","when i was"];
    return Math.min(100,45+markers.filter(m=>response.toLowerCase().includes(m)).length*16);
  })();
  const brevity = (() => {
    const r = words/question.minExpectedTokens;
    if(r<0.5) return 50;
    if(r>2.0){flags.push("VERBOSE");return 45;}
    return Math.round(75+(1-Math.abs(r-1))*25);
  })();
  const timeRatio = timeTaken/question.maxTime;
  let timePenalty=0;
  if(timeRatio>1.2){flags.push("OVERTIME");timePenalty=8;}
  else if(timeRatio<0.15&&words<20){flags.push("RUSHED");timePenalty=5;}
  const raw = relevance*0.25+depth*0.25+clarity*0.20+examples*0.20+brevity*0.10;
  const total = Math.round(Math.max(0,Math.min(100,raw-timePenalty+(question.difficulty-1)*2)));
  return { total, breakdown:{relevance,depth,clarity,examples,brevity}, flags, timePenalty };
}

function selectNextQuestion(answered, scores, all) {
  const used = new Set(answered.map(a=>a.questionId));
  const avail = all.filter(q=>!used.has(q.id));
  if(!avail.length) return null;
  const avgRecent = scores.slice(-2).length ? scores.slice(-2).reduce((a,b)=>a+b,0)/scores.slice(-2).length : 70;
  const targetDiff = avgRecent>=80?3:avgRecent>=60?2:1;
  const catCounts = {};
  answered.forEach(a=>{ const q=all.find(q=>q.id===a.questionId); if(q) catCounts[q.category]=(catCounts[q.category]||0)+1; });
  return [...avail].sort((a,b)=>{
    const dA=Math.abs(a.difficulty-targetDiff), dB=Math.abs(b.difficulty-targetDiff);
    if(dA!==dB) return dA-dB;
    return (catCounts[a.category]||0)-(catCounts[b.category]||0);
  })[0];
}

function checkTermination(answers, scores, startTime) {
  if(answers.length>=TERMINATION_RULES.maxQuestions) return {terminate:true,reason:"MAX_QUESTIONS_REACHED"};
  if((Date.now()-startTime)/60000>=TERMINATION_RULES.maxDurationMinutes) return {terminate:true,reason:"TIME_LIMIT_EXCEEDED"};
  const recentSkips = answers.slice(-TERMINATION_RULES.consecutiveSkips).filter(a=>a.skipped).length;
  if(answers.length>=TERMINATION_RULES.consecutiveSkips && recentSkips>=TERMINATION_RULES.consecutiveSkips) return {terminate:true,reason:"CONSECUTIVE_SKIPS"};
  if(scores.length>=TERMINATION_RULES.consecutiveLowScores && scores.slice(-TERMINATION_RULES.consecutiveLowScores).every(s=>s<TERMINATION_RULES.lowScoreCutoff)) return {terminate:true,reason:"LOW_PERFORMANCE"};
  if(scores.length>=2 && scores.reduce((a,b)=>a+b,0)/scores.length<TERMINATION_RULES.minScoreThreshold) return {terminate:true,reason:"BELOW_THRESHOLD"};
  return {terminate:false};
}

function computeFinalScore(answers, scores, startTime) {
  if(!scores.length) return {readiness:0,grade:"F",avgScore:0,completionRate:0,difficultyWeighted:0,categoryAvgs:{},strengths:[],weaknesses:[],elapsed:0};
  const avgScore = scores.reduce((a,b)=>a+b,0)/scores.length;
  const completionRate = answers.filter(a=>!a.skipped).length/answers.length;
  const totalDiff = answers.reduce((s,a)=>{ const q=QUESTION_BANK.find(q=>q.id===a.questionId); return s+(q?.difficulty||1); },0);
  const diffW = answers.reduce((s,a)=>{ const q=QUESTION_BANK.find(q=>q.id===a.questionId); return s+(a.score?.total||0)*(q?.difficulty||1); },0)/Math.max(totalDiff,1);
  const readiness = Math.round(avgScore*0.45+completionRate*100*0.20+diffW*0.25+Math.min(100,scores.length*12.5)*0.10);
  const grade = readiness>=90?"A+":readiness>=80?"A":readiness>=70?"B":readiness>=60?"C":readiness>=50?"D":"F";
  const catMap = {};
  answers.forEach(a=>{ const q=QUESTION_BANK.find(q=>q.id===a.questionId); if(!q||a.skipped)return; if(!catMap[q.category])catMap[q.category]=[]; catMap[q.category].push(a.score?.total||0); });
  const categoryAvgs = Object.fromEntries(Object.entries(catMap).map(([c,arr])=>[c,Math.round(arr.reduce((a,b)=>a+b,0)/arr.length)]));
  const strengths=[],weaknesses=[];
  Object.entries(categoryAvgs).forEach(([c,v])=>{ if(v>=70)strengths.push(c); else if(v<55)weaknesses.push(c); });
  return {readiness,grade,avgScore:Math.round(avgScore),completionRate:Math.round(completionRate*100),difficultyWeighted:Math.round(diffW),categoryAvgs,strengths,weaknesses,elapsed:Math.round((Date.now()-startTime)/60000)};
}

function RadialScore({ value, size=80 }) {
  const r = (size/2)-6;
  const circ = 2*Math.PI*r;
  const dash = (value/100)*circ;
  const color = value>=70?"#1D9E75":value>=50?"#BA7517":"#E24B4A";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Score ${value}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--color-border-tertiary)" strokeWidth="4"/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`} style={{transition:"stroke-dasharray 0.8s ease"}}/>
      <text x={size/2} y={size/2+1} textAnchor="middle" dominantBaseline="middle"
        style={{fontSize:size>60?15:12,fontWeight:500,fill:"var(--color-text-primary)",fontFamily:"var(--font-sans)"}}>{value}</text>
    </svg>
  );
}

function ScoreBar({ label, value, color }) {
  return (
    <div style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:4}}>
        <span style={{color:"var(--color-text-secondary)",textTransform:"capitalize"}}>{label}</span>
        <span style={{color:"var(--color-text-primary)",fontWeight:500}}>{Math.round(value)}</span>
      </div>
      <div style={{height:5,background:"var(--color-border-tertiary)",borderRadius:3}}>
        <div style={{width:`${value}%`,height:"100%",background:color,borderRadius:3,transition:"width 0.8s ease"}}/>
      </div>
    </div>
  );
}

function PulsingDot({ color="#1D9E75" }) {
  return (
    <span style={{display:"inline-block",width:8,height:8,borderRadius:"50%",background:color,marginRight:6,animation:"pulse 1.5s infinite"}}/>
  );
}

function TypewriterText({ text, speed=18 }) {
  const [displayed, setDisplayed] = useState("");
  useEffect(()=>{
    setDisplayed("");
    let i=0;
    const t = setInterval(()=>{ i++; setDisplayed(text.slice(0,i)); if(i>=text.length)clearInterval(t); },speed);
    return ()=>clearInterval(t);
  },[text]);
  return <span>{displayed}<span style={{opacity:displayed.length<text.length?1:0}}>|</span></span>;
}

function AIFeedbackPanel({ feedback, loading }) {
  if(loading) return (
    <div style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"1rem",marginTop:12}}>
      <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"var(--color-text-secondary)"}}>
        <PulsingDot color="#7F77DD"/>
        AI interviewer is reviewing your answer…
      </div>
    </div>
  );
  if(!feedback) return null;
  return (
    <div style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginTop:12,borderLeft:"3px solid #7F77DD",borderRadius:0}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
        <i className="ti ti-robot" aria-hidden="true" style={{fontSize:15,color:"#7F77DD"}}/>
        <span style={{fontSize:12,color:"#534AB7",fontWeight:500}}>AI interviewer feedback</span>
      </div>
      <div style={{fontSize:13,color:"var(--color-text-primary)",lineHeight:1.7}}>{feedback}</div>
    </div>
  );
}

function SessionTimeline({ answers }) {
  if(!answers.length) return null;
  return (
    <div style={{position:"relative",paddingLeft:20}}>
      <div style={{position:"absolute",left:7,top:0,bottom:0,width:1,background:"var(--color-border-tertiary)"}}/>
      {answers.map((a,i)=>{
        const q=QUESTION_BANK.find(q=>q.id===a.questionId);
        const meta=CAT_META[q?.category||"behavioral"];
        const s=a.score?.total||0;
        const dotColor=a.skipped?"var(--color-text-tertiary)":s>=70?"#1D9E75":s>=50?"#BA7517":"#E24B4A";
        return (
          <div key={i} style={{display:"flex",gap:12,marginBottom:16,position:"relative"}}>
            <div style={{position:"absolute",left:-16,top:4,width:10,height:10,borderRadius:"50%",background:dotColor,border:"2px solid var(--color-background-primary)"}}/>
            <div style={{flex:1,background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",padding:"10px 12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:4}}>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:11,padding:"2px 8px",borderRadius:20,background:meta.bg,color:meta.text}}>{q?.category}</span>
                  <span style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{DIFF_LABEL[q?.difficulty||1]}</span>
                </div>
                <span style={{fontSize:16,fontWeight:500,color:dotColor}}>{a.skipped?"—":s}</span>
              </div>
              <div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.5}}>{q?.text}</div>
              {!a.skipped && a.score?.breakdown && (
                <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
                  {Object.entries(a.score.breakdown).map(([k,v])=>(
                    <div key={k} style={{fontSize:10,color:"var(--color-text-tertiary)"}}>
                      {k.charAt(0).toUpperCase()+k.slice(1)}: <span style={{fontWeight:500,color:"var(--color-text-secondary)"}}>{Math.round(v)}</span>
                    </div>
                  ))}
                </div>
              )}
              {a.aiFeedback && (
                <div style={{marginTop:8,paddingTop:8,borderTop:"0.5px solid var(--color-border-tertiary)",fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.6}}>{a.aiFeedback}</div>
              )}
              {a.score?.flags?.length>0 && (
                <div style={{display:"flex",gap:4,marginTop:6,flexWrap:"wrap"}}>
                  {a.score.flags.map(f=>(
                    <span key={f} style={{fontSize:10,padding:"2px 7px",borderRadius:10,background:"var(--color-background-warning)",color:"var(--color-text-warning)"}}>{f.replace(/_/g," ").toLowerCase()}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HexGrid({ scores }) {
  const dims = [
    {label:"Relevance",key:"relevance"},
    {label:"Depth",key:"depth"},
    {label:"Clarity",key:"clarity"},
    {label:"Examples",key:"examples"},
    {label:"Brevity",key:"brevity"},
  ];
  const avg = key => {
    const vals = scores.filter(s=>s.breakdown?.[key]).map(s=>s.breakdown[key]);
    return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) : 0;
  };
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
      {dims.map(d=>{
        const val=avg(d.key);
        const color=val>=70?"#1D9E75":val>=50?"#BA7517":"#E24B4A";
        return (
          <div key={d.key} style={{textAlign:"center",background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",padding:"10px 6px"}}>
            <RadialScore value={val} size={52}/>
            <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:4}}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

async function callClaudeAPI(systemPrompt, userMessage) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model:"claude-sonnet-4-20250514",
      max_tokens:1000,
      system: systemPrompt,
      messages:[{role:"user",content:userMessage}]
    })
  });
  const data = await res.json();
  return data.content?.find(c=>c.type==="text")?.text || "";
}

const INTERVIEWER_SYSTEM = `You are a professional technical interviewer at a top-tier technology company. Your role is to provide precise, actionable, and balanced feedback on interview answers.

When giving feedback on an answer:
- Be specific, not generic
- Note what was strong and what was missing
- Reference the STAR method (Situation, Task, Action, Result) for behavioral questions
- Keep feedback to 2-4 sentences maximum
- Be constructive but honest about gaps
- Never be harsh or discouraging, but don't sugarcoat weaknesses
- Focus on what would make the answer stronger

Your feedback should feel like it comes from a thoughtful human interviewer, not a checklist.`;

const COACH_SYSTEM = `You are an expert interview coach analyzing a completed mock interview session. You have deep expertise in technical interviews, behavioral assessments, and career coaching.

Provide a coaching analysis that:
- Identifies the candidate's top 2 strengths with specific evidence from the session
- Identifies the top 2 areas for improvement with concrete advice
- Gives one specific technique or framework they should practice
- Ends with an encouraging but honest overall assessment

Keep the total response to 4-6 sentences. Be specific, actionable, and human.`;

export default function InterviewEngine() {
  const [phase, setPhase] = useState("setup");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [currentQ, setCurrentQ] = useState(null);
  const [response, setResponse] = useState("");
  const [answers, setAnswers] = useState([]);
  const [scores, setScores] = useState([]);
  const [startTime, setStartTime] = useState(null);
  const [qStart, setQStart] = useState(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [totalElapsed, setTotalElapsed] = useState(0);
  const [termReason, setTermReason] = useState(null);
  const [finalResult, setFinalResult] = useState(null);
  const [aiFeedback, setAiFeedback] = useState(null);
  const [aiFeedbackLoading, setAiFeedbackLoading] = useState(false);
  const [coachInsight, setCoachInsight] = useState(null);
  const [coachLoading, setCoachLoading] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [questionVisible, setQuestionVisible] = useState(false);
  const [scoreReveal, setScoreReveal] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const timerRef = useRef(null);
  const totalTimerRef = useRef(null);

  useEffect(()=>{
    if(phase==="active"&&currentQ){
      setTimeLeft(currentQ.maxTime);
      clearInterval(timerRef.current);
      timerRef.current=setInterval(()=>setTimeLeft(t=>{if(t<=1){clearInterval(timerRef.current);return 0;}return t-1;}),1000);
    }
    return ()=>clearInterval(timerRef.current);
  },[currentQ,phase]);

  useEffect(()=>{
    if(phase==="active"){
      totalTimerRef.current=setInterval(()=>setTotalElapsed(e=>e+1),1000);
    }
    return()=>clearInterval(totalTimerRef.current);
  },[phase]);

  function start() {
    const st=Date.now();
    setStartTime(st);
    setAnswers([]);setScores([]);setTotalElapsed(0);setAiFeedback(null);
    const first=selectNextQuestion([],[],QUESTION_BANK);
    setCurrentQ(first);
    setQStart(Date.now());
    setResponse("");setWordCount(0);
    setPhase("active");
    setTimeout(()=>setQuestionVisible(true),100);
  }

  async function handleSubmit(skip=false) {
    if(!currentQ) return;
    clearInterval(timerRef.current);
    const timeTaken=Math.round((Date.now()-qStart)/1000);
    const scored=skip?{total:0,breakdown:{},flags:["SKIPPED"]}:scoreResponse(response,currentQ,timeTaken);
    const newAnswers=[...answers,{questionId:currentQ.id,response:skip?"":response,timeTaken,score:scored,skipped:skip,aiFeedback:null}];
    const newScores=[...scores,scored.total];
    setAnswers(newAnswers);setScores(newScores);

    if(!skip && response.trim().length>20){
      setAiFeedbackLoading(true);
      setAiFeedback(null);
      try {
        const fb = await callClaudeAPI(INTERVIEWER_SYSTEM,
          `Question: "${currentQ.text}"\n\nCandidate's answer: "${response}"\n\nProvide brief feedback on this answer.`
        );
        setAiFeedback(fb);
        newAnswers[newAnswers.length-1].aiFeedback=fb;
        setAnswers([...newAnswers]);
      } catch(e){
        setAiFeedback("Could not load AI feedback at this time.");
      }
      setAiFeedbackLoading(false);
      await new Promise(r=>setTimeout(r,1800));
    }

    const term=checkTermination(newAnswers,newScores,startTime);
    if(term.terminate||!selectNextQuestion(newAnswers,newScores,QUESTION_BANK)){
      clearInterval(totalTimerRef.current);
      setTermReason(term.terminate?term.reason:"ALL_QUESTIONS_DONE");
      const result=computeFinalScore(newAnswers,newScores,startTime);
      setFinalResult(result);
      setPhase("result");
      setScoreReveal(false);
      setTimeout(()=>setScoreReveal(true),300);
      setCoachLoading(true);
      try {
        const summary=newAnswers.map((a,i)=>{
          const q=QUESTION_BANK.find(q=>q.id===a.questionId);
          return `Q${i+1} [${q?.category}/${DIFF_LABEL[q?.difficulty||1]}]: Score ${a.score?.total||0}${a.skipped?" (skipped)":""}`;
        }).join("\n");
        const ci=await callClaudeAPI(COACH_SYSTEM,
          `Candidate: ${name||"Candidate"}\nRole: ${role||"General"}\nReadiness Score: ${result.readiness}/100\nGrade: ${result.grade}\n\nSession summary:\n${summary}\n\nProvide coaching insights.`
        );
        setCoachInsight(ci);
      } catch(e){ setCoachInsight("Could not load coaching insights."); }
      setCoachLoading(false);
      return;
    }

    setTransitioning(true);setQuestionVisible(false);
    await new Promise(r=>setTimeout(r,350));
    const next=selectNextQuestion(newAnswers,newScores,QUESTION_BANK);
    setCurrentQ(next);setQStart(Date.now());setResponse("");setWordCount(0);setAiFeedback(null);setAiFeedbackLoading(false);
    setTransitioning(false);
    setTimeout(()=>setQuestionVisible(true),50);
  }

  function reset(){
    clearInterval(timerRef.current);clearInterval(totalTimerRef.current);
    setPhase("setup");setAnswers([]);setScores([]);setCurrentQ(null);setResponse("");
    setFinalResult(null);setTermReason(null);setAiFeedback(null);setCoachInsight(null);setWordCount(0);setQuestionVisible(false);
  }

  const elMin=Math.floor(totalElapsed/60);
  const elSec=totalElapsed%60;
  const timePct=currentQ?(timeLeft/currentQ.maxTime*100):100;
  const timerColor=timePct>50?"#1D9E75":timePct>25?"#BA7517":"#E24B4A";
  const progPct=Math.round(answers.length/TERMINATION_RULES.maxQuestions*100);

  return (
    <div style={{maxWidth:680,margin:"0 auto",padding:"1.5rem 1rem"}}>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}} @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}} @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}} .q-enter{animation:fadeIn 0.35s ease forwards} .score-reveal{animation:slideUp 0.5s ease forwards}`}</style>
      <h2 className="sr-only">Interview Saathi — AI-powered interview simulator with real-time feedback and readiness scoring</h2>

      {phase==="setup" && (
        <div style={{animation:"fadeIn 0.4s ease"}}>
          <div style={{marginBottom:"2rem"}}>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect width="48" height="48" rx="13" fill="#EEEDFE"/>
                <circle cx="24" cy="18" r="7" fill="#7F77DD"/>
                <path d="M12 36c0-6.627 5.373-12 12-12s12 5.373 12 12" stroke="#7F77DD" strokeWidth="2.5" strokeLinecap="round"/>
                <circle cx="35" cy="14" r="6" fill="#534AB7"/>
                <path d="M32 14h6M35 11v6" stroke="#EEEDFE" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              <div>
                <div style={{fontSize:11,letterSpacing:2,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)",textTransform:"uppercase"}}>Interview Saathi</div>
                <div style={{fontSize:20,fontWeight:500,color:"var(--color-text-primary)",lineHeight:1.2}}>Your AI-powered interview companion</div>
              </div>
            </div>
            <p style={{fontSize:14,color:"var(--color-text-secondary)",lineHeight:1.7,margin:0}}>
              A live AI interviewer scores your responses across 5 dimensions, adapts difficulty in real time, and delivers coaching insights at the end.
            </p>
          </div>

          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1.25rem",marginBottom:"1rem"}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <div>
                <label style={{display:"block",fontSize:12,color:"var(--color-text-secondary)",marginBottom:5}}>Your name</label>
                <input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Alex Chen" style={{width:"100%",boxSizing:"border-box"}}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:12,color:"var(--color-text-secondary)",marginBottom:5}}>Target role</label>
                <input value={role} onChange={e=>setRole(e.target.value)} placeholder="e.g. Senior Engineer" style={{width:"100%",boxSizing:"border-box"}}/>
              </div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:"1.25rem"}}>
            {[
              {icon:"ti-robot",color:"#7F77DD",bg:"#EEEDFE",label:"Live AI feedback",sub:"After each answer"},
              {icon:"ti-trending-up",color:"#1D9E75",bg:"#E1F5EE",label:"Adaptive difficulty",sub:"Responds to your pace"},
              {icon:"ti-award",color:"#D85A30",bg:"#FAECE7",label:"Readiness score",sub:"With coaching insights"},
            ].map((f,i)=>(
              <div key={i} style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-md)",padding:"12px 10px"}}>
                <div style={{width:32,height:32,borderRadius:"var(--border-radius-md)",background:f.bg,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>
                  <i className={`ti ${f.icon}`} aria-hidden="true" style={{fontSize:16,color:f.color}}/>
                </div>
                <div style={{fontSize:13,fontWeight:500,color:"var(--color-text-primary)"}}>{f.label}</div>
                <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{f.sub}</div>
              </div>
            ))}
          </div>

          <div style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"1rem",marginBottom:"1.25rem"}}>
            <div style={{fontSize:12,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)",marginBottom:8}}>Session rules</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 24px",fontSize:13,color:"var(--color-text-secondary)"}}>
              <div style={{display:"flex",justifyContent:"space-between",paddingRight:24}}><span>Max questions</span><span style={{fontWeight:500,color:"var(--color-text-primary)"}}>{TERMINATION_RULES.maxQuestions}</span></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Time limit</span><span style={{fontWeight:500,color:"var(--color-text-primary)"}}>{TERMINATION_RULES.maxDurationMinutes} min</span></div>
              <div style={{display:"flex",justifyContent:"space-between",paddingRight:24}}><span>Skip limit</span><span style={{fontWeight:500,color:"var(--color-text-primary)"}}>{TERMINATION_RULES.consecutiveSkips} consecutive</span></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Low score exit</span><span style={{fontWeight:500,color:"var(--color-text-primary)"}}>&lt;{TERMINATION_RULES.lowScoreCutoff} ×{TERMINATION_RULES.consecutiveLowScores}</span></div>
            </div>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:"1.25rem"}}>
            {Object.entries(CAT_META).map(([cat,m])=>(
              <div key={cat} style={{background:m.bg,borderRadius:"var(--border-radius-md)",padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
                <i className={`ti ${m.icon}`} aria-hidden="true" style={{fontSize:15,color:m.color}}/>
                <div>
                  <div style={{fontSize:12,fontWeight:500,color:m.text,textTransform:"capitalize"}}>{cat}</div>
                  <div style={{fontSize:11,color:m.color}}>{QUESTION_BANK.filter(q=>q.category===cat).length} questions</div>
                </div>
              </div>
            ))}
          </div>

          <button onClick={start} style={{width:"100%",padding:"13px",fontSize:15,cursor:"pointer",fontWeight:500}}>
            Start interview session ↗
          </button>
        </div>
      )}

      {phase==="active" && currentQ && (
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"1rem"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontSize:13,color:"var(--color-text-secondary)",fontFamily:"var(--font-mono)"}}>
                {answers.length+1}<span style={{color:"var(--color-text-tertiary)"}}>/{TERMINATION_RULES.maxQuestions}</span>
              </div>
              <div style={{width:100,height:3,background:"var(--color-border-tertiary)",borderRadius:2}}>
                <div style={{width:`${progPct}%`,height:"100%",background:"var(--color-text-secondary)",borderRadius:2,transition:"width 0.5s"}}/>
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              {scores.length>0 && (
                <div style={{fontSize:12,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)"}}>
                  avg <span style={{color:"var(--color-text-primary)",fontWeight:500}}>{Math.round(scores.reduce((a,b)=>a+b,0)/scores.length)}</span>
                </div>
              )}
              <div style={{fontSize:12,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)"}}>
                {elMin}:{String(elSec).padStart(2,"0")}
              </div>
            </div>
          </div>

          <div className={questionVisible?"q-enter":""} style={{opacity:transitioning?0:1,transition:"opacity 0.3s"}}>
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-secondary)",borderRadius:"var(--border-radius-lg)",padding:"1.25rem",marginBottom:"1rem"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  <span style={{fontSize:12,padding:"3px 10px",borderRadius:20,background:CAT_META[currentQ.category].bg,color:CAT_META[currentQ.category].text}}>
                    <i className={`ti ${CAT_META[currentQ.category].icon}`} aria-hidden="true" style={{fontSize:11,marginRight:4}}/>
                    {currentQ.category}
                  </span>
                  <span style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{DIFF_LABEL[currentQ.difficulty]} level</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:72,height:4,background:"var(--color-border-tertiary)",borderRadius:2}}>
                    <div style={{width:`${timePct}%`,height:"100%",background:timerColor,borderRadius:2,transition:"width 1s linear, background 0.5s"}}/>
                  </div>
                  <span style={{fontSize:12,fontFamily:"var(--font-mono)",color:timerColor,minWidth:32}}>{timeLeft}s</span>
                </div>
              </div>
              <div style={{fontSize:16,lineHeight:1.65,color:"var(--color-text-primary)"}}>
                <TypewriterText text={currentQ.text} speed={14}/>
              </div>
            </div>

            <div style={{position:"relative",marginBottom:8}}>
              <textarea
                value={response}
                onChange={e=>{ setResponse(e.target.value); setWordCount(e.target.value.trim().split(/\s+/).filter(Boolean).length); }}
                placeholder="Type your response here — be specific and use concrete examples where possible…"
                style={{width:"100%",boxSizing:"border-box",minHeight:130,resize:"vertical",fontSize:14,lineHeight:1.7,padding:"12px",paddingBottom:32,fontFamily:"var(--font-sans)"}}
              />
              <div style={{position:"absolute",bottom:10,right:12,fontSize:11,color:wordCount>=currentQ.minExpectedTokens?"#1D9E75":"var(--color-text-tertiary)",fontFamily:"var(--font-mono)"}}>
                {wordCount} / ~{currentQ.minExpectedTokens} words
              </div>
            </div>

            {scores.length>0 && (
              <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                {scores.map((s,i)=>{
                  const c=s>=70?"#1D9E75":s>=50?"#BA7517":"#E24B4A";
                  return <div key={i} style={{width:28,height:28,borderRadius:"var(--border-radius-md)",background:`${c}1A`,border:`0.5px solid ${c}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:c}}>{s}</div>;
                })}
                <div style={{width:28,height:28,borderRadius:"var(--border-radius-md)",border:"0.5px dashed var(--color-border-tertiary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"var(--color-text-tertiary)"}}>?</div>
              </div>
            )}

            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>handleSubmit(false)} disabled={!response.trim()||aiFeedbackLoading} style={{flex:1,padding:"11px",cursor:response.trim()&&!aiFeedbackLoading?"pointer":"not-allowed",opacity:response.trim()&&!aiFeedbackLoading?1:0.4}}>
                {aiFeedbackLoading?"Analyzing…":"Submit answer"}
              </button>
              <button onClick={()=>handleSubmit(true)} disabled={aiFeedbackLoading} style={{padding:"11px 18px",cursor:"pointer",color:"var(--color-text-secondary)"}}>
                Skip
              </button>
            </div>

            <AIFeedbackPanel feedback={aiFeedback} loading={aiFeedbackLoading}/>
          </div>
        </div>
      )}

      {phase==="result" && finalResult && (
        <div className="score-reveal">
          <div style={{textAlign:"center",marginBottom:"1.5rem",paddingBottom:"1.5rem",borderBottom:"0.5px solid var(--color-border-tertiary)"}}>
            <div style={{fontSize:11,letterSpacing:2,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)",textTransform:"uppercase",marginBottom:12}}>Saathi report</div>
            <div style={{display:"flex",justifyContent:"center",marginBottom:12}}>
              <RadialScore value={scoreReveal?finalResult.readiness:0} size={100}/>
            </div>
            <div style={{fontSize:32,fontWeight:500,color:"var(--color-text-primary)"}}>{finalResult.readiness}<span style={{fontSize:16,color:"var(--color-text-tertiary)"}}>/100</span></div>
            <div style={{fontSize:15,color:"var(--color-text-secondary)"}}>Saathi Readiness Score · Grade <span style={{fontWeight:500,color:"var(--color-text-primary)"}}>{finalResult.grade}</span></div>
            {termReason && (
              <div style={{display:"inline-flex",alignItems:"center",gap:6,marginTop:10,fontSize:12,padding:"5px 12px",borderRadius:20,background:"var(--color-background-secondary)",color:"var(--color-text-tertiary)"}}>
                <i className="ti ti-info-circle" aria-hidden="true" style={{fontSize:13}}/>
                {termReason.replace(/_/g," ").toLowerCase()}
              </div>
            )}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:"1.25rem"}}>
            {[
              {label:"Avg score",value:finalResult.avgScore},
              {label:"Completion",value:`${finalResult.completionRate}%`},
              {label:"Questions",value:answers.length},
              {label:"Duration",value:`${finalResult.elapsed}m`},
            ].map((m,i)=>(
              <div key={i} style={{background:"var(--color-background-secondary)",borderRadius:"var(--border-radius-md)",padding:"10px 12px"}}>
                <div style={{fontSize:11,color:"var(--color-text-tertiary)"}}>{m.label}</div>
                <div style={{fontSize:20,fontWeight:500,color:"var(--color-text-primary)",marginTop:2}}>{m.value}</div>
              </div>
            ))}
          </div>

          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginBottom:"1rem"}}>
            <div style={{fontSize:12,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)",marginBottom:12}}>Scoring dimensions (average across all answers)</div>
            <HexGrid scores={answers.filter(a=>!a.skipped).map(a=>a.score).filter(Boolean)}/>
          </div>

          {Object.keys(finalResult.categoryAvgs).length>0 && (
            <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginBottom:"1rem"}}>
              <div style={{fontSize:12,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)",marginBottom:12}}>Category performance</div>
              {Object.entries(finalResult.categoryAvgs).map(([cat,avg])=>(
                <ScoreBar key={cat} label={cat} value={avg} color={CAT_META[cat]?.color||"#888"}/>
              ))}
            </div>
          )}

          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginBottom:"1rem"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:12}}>
              <i className="ti ti-robot" aria-hidden="true" style={{fontSize:15,color:"#534AB7"}}/>
              <span style={{fontSize:12,color:"#534AB7",fontWeight:500,fontFamily:"var(--font-mono)"}}>AI coach analysis</span>
            </div>
            {coachLoading ? (
              <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"var(--color-text-secondary)"}}>
                <PulsingDot color="#7F77DD"/>
                Generating personalized coaching insights…
              </div>
            ) : coachInsight ? (
              <div style={{fontSize:14,color:"var(--color-text-primary)",lineHeight:1.75}}>{coachInsight}</div>
            ) : null}
          </div>

          {(finalResult.strengths.length>0||finalResult.weaknesses.length>0) && (
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:"1rem"}}>
              {finalResult.strengths.length>0 && (
                <div style={{background:"var(--color-background-success)",borderRadius:"var(--border-radius-md)",padding:"0.875rem"}}>
                  <div style={{fontSize:11,color:"var(--color-text-success)",fontFamily:"var(--font-mono)",marginBottom:6}}>Strengths</div>
                  {finalResult.strengths.map(s=>(
                    <div key={s} style={{fontSize:13,color:"var(--color-text-success)",display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                      <i className="ti ti-check" aria-hidden="true" style={{fontSize:13}}/>
                      <span style={{textTransform:"capitalize"}}>{s}</span>
                    </div>
                  ))}
                </div>
              )}
              {finalResult.weaknesses.length>0 && (
                <div style={{background:"var(--color-background-warning)",borderRadius:"var(--border-radius-md)",padding:"0.875rem"}}>
                  <div style={{fontSize:11,color:"var(--color-text-warning)",fontFamily:"var(--font-mono)",marginBottom:6}}>Needs work</div>
                  {finalResult.weaknesses.map(s=>(
                    <div key={s} style={{fontSize:13,color:"var(--color-text-warning)",display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                      <i className="ti ti-arrow-up" aria-hidden="true" style={{fontSize:13}}/>
                      <span style={{textTransform:"capitalize"}}>{s}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",borderRadius:"var(--border-radius-lg)",padding:"1rem 1.25rem",marginBottom:"1.25rem"}}>
            <div style={{fontSize:12,color:"var(--color-text-tertiary)",fontFamily:"var(--font-mono)",marginBottom:14}}>Full session timeline</div>
            <SessionTimeline answers={answers}/>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <button onClick={reset} style={{padding:"12px",cursor:"pointer"}}>
              New session ↗
            </button>
            <button onClick={()=>sendPrompt(`I just completed an Interview Saathi session with a readiness score of ${finalResult.readiness}/100 (grade ${finalResult.grade}). My strengths were ${finalResult.strengths.join(", ")||"not identified"} and areas to improve are ${finalResult.weaknesses.join(", ")||"not identified"}. Can you give me a deeper coaching breakdown and suggest specific resources to improve?`)}
              style={{padding:"12px",cursor:"pointer"}}>
              Get deeper coaching ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
