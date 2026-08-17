// Words a screen is full of, which are therefore worthless as dictation vocabulary.
//
// Separate from COMMON_WORDS on purpose. That set answers a different question —
// "is this word unremarkable enough that lowercasing it at an utterance boundary is
// safe?" — and transcriptSegments depends on it staying small. This set answers
// "would seeing this word on screen tell us anything about what the speaker said?",
// and the answer for UI chrome and ordinary prose is no.
//
// The screen-term matcher consults both. A term surviving them is one a recognizer
// plausibly mangles: a product, a person, a repository, an identifier.
//
// Two families are covered, because both fill a window and neither is a name:
//
//   1. High-frequency English beyond the function words in COMMON_WORDS —
//      "three", "error", "move", "message" all leaked through and were reported.
//   2. Modern application and computing vocabulary. The system dictionary
//      (/usr/share/dict/web2, Webster's 1934) predates all of it: "email",
//      "website", "settings", "download", "inbox" and "online" are absent from it,
//      so nothing else catches them.
//
// Written space-separated rather than one string per line: this is a word list, and
// a thousand quoted lines would bury it.
const WORDS = `
  able accept access according account across action active activity actual actually
  add added address admin advanced after against ago agree ahead alert align allow
  almost alone along already alright although among amount analytics another answer
  anyone anything anyway apart api appear apply approve april archive area around
  array arrive article ask aside assign assume attach attachment attempt audio
  august author auto available average avatar avoid away back background backup badge
  balance banner bar base based basic batch become before begin behind believe belong
  below best better between beyond big bigger bill billing black blank block blog
  blue board body book bookmark boolean border both bottom box branch break bright
  bring broken browse browser bug build built bulk bundle business busy cache
  calendar call cancel cannot capacity card care carry case catch category cause cell
  center certain chain chance change channel chapter character charge chart chat check
  child choice choose city claim class classic clean clear click client clone close
  closed cloud cluster code collapse collect color column combine come comment commit
  common community company compare complete component compose computer condition
  config configure confirm connect connected connection console const contact contain
  content context continue control convert cookie copy core correct cost could count
  country course cover crash create created credit critical current custom customer
  cycle daily dark dashboard data database date day days deal debug december decide
  default define delay delete deleted deliver demo deny depend deploy describe
  description design desktop detail details detect determine develop device dialog
  did difference different digital direct direction directory disable disabled
  discard discount discover discuss display distribute document documentation does
  domain done double down download draft drag draw drive drop dropdown due duplicate
  duration during each early easier easy edit editor education effect either element
  else email embed empty enable enabled encode end endpoint engine english enough
  enter entire entry environment equal error escape especially essential estimate
  even evening event eventually every everyone everything exact example exceed except
  exchange exclude execute exist exit expand expect expense experience expire explain
  explore export express extend extension external extra face fact factor fail
  failed failure false family fast faster favorite feature february feed feedback few
  field figure file fill filter final finally find fine finish first fit five fix
  fixed flag flat flow focus folder follow following font footer force forever forget
  form format forum forward found four frame free frequent friday friend from front
  full fully function further future gain game gateway general generate get gift give
  given global goal going gone good grant graph gray great green grid group grow
  guest guide had half handle happen hard hardware has have header health hear heart
  heavy height hello help helper here hidden hide high higher highlight history hold
  home hope host hosting hour hours house how however html http human hundred icon
  idea identify idle ignore image immediately impact import important improve inbox
  include including income increase index indicate individual industry info
  information initial input insert inside insight install instance instead
  instruction integration interest interface internal internet into introduce invalid
  invite invoice involve issue item itself january job join json july jump june just
  keep key keyboard kind know known label language large larger last late later
  latest launch layer layout lead learn least leave left legacy length less let level
  library license life light like likely limit line link list listen little live load
  loading local locale location lock log logic login logout long longer look loop
  loss lost lot love low lower machine made mail main maintain major make manage
  manager many map march margin mark market master match material matter maximum may
  maybe mean measure media medium meet meeting member memory mention menu merge
  message method middle might migrate million minimum minor minute mirror miss
  missing mistake mobile mode model modern modify module moment monday money monitor
  month more morning most mount mouse move moved movie much multiple music must mute
  myself name native natural navigate near nearly necessary need needed network never
  new newer news newsletter next nice night nine node none normal north not note
  nothing notice notification november now null number object october offer office
  offline often okay older once ongoing online only onto open opened operation
  opinion option optional order organization origin original other otherwise ought
  outbox outcome outline output outside over overall overview owner package page
  paid panel paper paragraph parameter parent part partial participant particular
  partner party pass password past paste path pattern pause payment pending people
  per percent perfect perform performance period permission person personal phone
  photo pick picture piece pin pipeline place plain plan platform play please plus
  point policy pool poor popular port portal position possible post power practice
  prefer preference premium prepare present preset press pressure preview previous
  price primary print prior priority privacy private probably problem process
  product profile program progress project prompt proper property propose protect
  protocol provide provider public publish pull purchase purpose push put quality
  quantity query question queue quick quickly quiet quit quota quote random range
  rate rather raw reach read reader ready real really reason receive recent
  recently recipient recommend record recover red redo reduce refer reference
  refresh region register regular reject relate release relevant reload remain
  remember remind reminder remote remove rename render repeat replace reply report
  repository represent request require required reset resolve resource respond
  response rest restart restore result resume retry return reveal reverse review
  revision reward rich right role room root rotate round route row rule run running
  safe said sample saturday save saved say scale scan schedule schema scope score
  screen script scroll search second secondary secret section secure security see
  seem select selected self send sender sent separate september sequence series
  serious serve server service session set setting settings setup seven several
  shape share shared sheet shift ship short should show shown side sign signal
  simple simply since single site situation six size skill skip slack sleep slide
  slow small smart snapshot social software solution solve some someone something
  sometimes soon sort sound source south space spam speak special specific speed
  spend split sponsor spread stable staff stage stand standard star start state
  statement static station status stay step still stop storage store story straight
  strategy stream street strength string strong structure study style subject submit
  subscribe subscription success successful such suggest suggestion summary sunday
  support sure surface survey suspend swap switch symbol sync syntax system tab
  table tag take target task team tech technical technology tell template temporary
  ten term terminal test text than thank that theme then theory there thing think
  third thirty this those though thought thousand three through throw thursday thus
  ticket tile time timeline timer title today together toggle token tomorrow
  tonight too tool toolbar top topic total touch toward trace track trade traffic
  transaction transfer transform transition translate transparent trash travel
  treat tree trend trial trigger trouble true trust try tuesday turn twelve twenty
  twice two type typical unable under understand undo unique unit unknown unless
  unlimited unlock until unread until update upgrade upload upon upper usage use
  used useful user username using usual usually valid validate value variable
  various version very via video view viewer virtual visible vision visit visual
  voice volume wait wake walk wall want warn warning watch water way weak wear web
  website wednesday week weekly weight welcome well went west what whatever when
  whenever where whether which while white who whole why wide width will win window
  wish with within without word work worker workflow workspace world worth would
  wrap write writer wrong yes yesterday yet you young your yours yourself zero zone
  zoom
`;

const SCREEN_CHROME_WORDS = new Set(WORDS.trim().split(/\s+/));

module.exports = { SCREEN_CHROME_WORDS };
